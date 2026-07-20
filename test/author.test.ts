import { expect, test } from "bun:test";
import type { NormalizedTC } from "../src/intake/schema.ts";
import { authorPlanAI, getOrAuthorPlan, MemoryPlanCache } from "../src/interpret/author.ts";
import { establishRuleFromHeaders } from "../src/interpret/rule.ts";
import { FakeModelClient } from "../src/model/model-client.ts";

function tc(over: Partial<NormalizedTC> = {}): NormalizedTC {
	return {
		caseId: "TC-1",
		sourceId: null,
		title: "login",
		steps: ["open the home page", "type admin into username", "click log in"],
		expected: "Welcome",
		priority: null,
		role: null,
		env: null,
		contentHash: "h1",
		...over,
	};
}

const PLAN_JSON = JSON.stringify({
	actions: [
		{ kind: "goto", path: "/" },
		{ kind: "fill", target: "Username", value: "admin" },
		{ kind: "click", target: "Log in" },
		{ kind: "bogus", target: "x" }, // dropped: unknown kind
		{ kind: "fill", target: "only-target" }, // dropped: missing value
	],
	assertions: [
		{ kind: "textIncludes", value: "Welcome" },
		{ kind: "textIncludes", value: "Welcome" }, // deduped
		{ kind: "nope", value: "x" }, // dropped: unknown kind
		{ kind: "urlIncludes", value: "/dashboard" },
	],
});

test("authorPlanAI parses + sanitizes model JSON into a valid plan", async () => {
	const plan = await authorPlanAI(tc(), new FakeModelClient(() => PLAN_JSON));
	expect(plan.actions).toEqual([
		{ kind: "goto", path: "/" },
		{ kind: "fill", target: "Username", value: "admin" },
		{ kind: "click", target: "Log in" },
	]);
	expect(plan.assertions).toEqual([
		{ kind: "textIncludes", value: "Welcome" },
		{ kind: "urlIncludes", value: "/dashboard" },
	]);
});

test("authorPlanAI tolerates prose around the JSON and empties on garbage", async () => {
	const wrapped = await authorPlanAI(tc(), new FakeModelClient(() => `Here you go:\n${PLAN_JSON}\nThanks.`));
	expect(wrapped.actions).toHaveLength(3);
	const garbage = await authorPlanAI(tc(), new FakeModelClient(() => "no json here"));
	expect(garbage).toEqual({ actions: [], assertions: [] });
});

test("getOrAuthorPlan authors once, then serves from cache (no second model call)", async () => {
	const rule = establishRuleFromHeaders([]);
	const cache = new MemoryPlanCache();
	let calls = 0;
	const model = new FakeModelClient(() => {
		calls++;
		return PLAN_JSON;
	});
	const first = await getOrAuthorPlan(tc(), rule, cache, model);
	expect(first.cacheHit).toBe(false);
	const second = await getOrAuthorPlan(tc(), rule, cache, model);
	expect(second.cacheHit).toBe(true);
	expect(calls).toBe(1);
	expect(second.plan.actions).toHaveLength(3);
});
