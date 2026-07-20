import { expect, test } from "bun:test";
import { type FakeAction, FakePage, type PageSnapshot } from "../src/execute/page.ts";
import { determinismView, type RunEnv, runScenario } from "../src/execute/runner.ts";
import type { NormalizedTC } from "../src/intake/schema.ts";
import { MemoryAssertionCache } from "../src/interpret/assertion.ts";
import { getOrAuthorAssertions } from "../src/interpret/interpret.ts";
import { bumpRuleVersion, establishRuleFromHeaders } from "../src/interpret/rule.ts";

const RULE = establishRuleFromHeaders(["Test ID", "Title", "Steps", "Expected Result", "Role", "Environment"]);
const ENV: RunEnv = { browser: "fake", viewport: "1280x800", baseUrl: "http://fixture" };

/** Deterministic login fixture: correct creds -> dashboard; wrong -> invalid; unknown target -> throw (heal). */
function loginReducer(action: FakeAction, state: PageSnapshot, inputs: Record<string, string>): PageSnapshot {
	if (action.kind === "goto") {
		return { url: action.target, text: `page ${action.target}`, html: `<main>page ${action.target}</main>` };
	}
	if (action.kind === "fill") return state;
	// click
	if (action.target.toLowerCase().includes("sign in")) {
		const ok = inputs.Username === "viewer" && inputs.Password === "viewer-pass";
		return ok
			? { url: "/dashboard", text: "Signed in as viewer", html: "<main>Signed in as viewer</main>" }
			: { url: "/login", text: "Invalid credentials", html: "<main>Invalid credentials</main>" };
	}
	throw new Error(`no element matches "${action.target}"`);
}

function loginTC(over: Partial<NormalizedTC> = {}): NormalizedTC {
	return {
		caseId: "TC-login",
		sourceId: "TC-01",
		title: "Viewer signs in",
		steps: [
			"Navigate to /login",
			'Enter "viewer" into "Username"',
			'Enter "viewer-pass" into "Password"',
			'Click "Sign in"',
			'Verify page shows "Signed in as viewer"',
		],
		expected: "Signed in as viewer",
		priority: null,
		role: "viewer",
		env: "staging",
		contentHash: "hash-login",
		...over,
	};
}

function run(tc: NormalizedTC) {
	const page = new FakePage({ url: "", text: "", html: "" }, loginReducer);
	return runScenario(tc, {
		page,
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
	});
}

test("pass: correct credentials satisfy the authored assertions", async () => {
	const r = await run(loginTC());
	expect(r.verdict).toBe("pass");
	expect(r.confidence).toBe(1);
	expect(r.healEvents).toEqual([]);
	expect(r.assertions.every((a) => a.passed)).toBe(true);
	expect(r.evidenceRefs.length).toBeGreaterThan(0);
});

test("fail: wrong password fails the expected-text assertion (no false pass)", async () => {
	const r = await run(
		loginTC({
			contentHash: "hash-wrong",
			steps: [
				"Navigate to /login",
				'Enter "viewer" into "Username"',
				'Enter "nope" into "Password"',
				'Click "Sign in"',
				'Verify page shows "Signed in as viewer"',
			],
		}),
	);
	expect(r.verdict).toBe("fail");
	expect(r.assertions.some((a) => !a.passed)).toBe(true);
	// confidence = confidence in the verdict; a clean all-fail is a high-confidence fail.
	expect(r.confidence).toBe(1);
});

test("needs_review: an unactionable target records a heal event and caps verdict (never silent pass)", async () => {
	const r = await run(
		loginTC({
			contentHash: "hash-heal",
			steps: ["Navigate to /login", 'Click "Nonexistent Button"', 'Verify page shows "Signed in as viewer"'],
		}),
	);
	expect(r.verdict).toBe("needs_review");
	expect(r.healEvents.length).toBeGreaterThan(0);
});

test("determinism: 5 reruns of the same case yield identical verdict/assertions/confidence", async () => {
	const views = [];
	for (let i = 0; i < 5; i++) views.push(determinismView(await run(loginTC())));
	for (const v of views) expect(v).toEqual(views[0] as (typeof views)[number]);
});

test("assertion cache: hit on rerun, miss when ruleVersion or caseHash changes (invalidation)", () => {
	const cache = new MemoryAssertionCache();
	const tc = loginTC();
	expect(getOrAuthorAssertions(tc, RULE, cache).cacheHit).toBe(false);
	expect(getOrAuthorAssertions(tc, RULE, cache).cacheHit).toBe(true);
	expect(getOrAuthorAssertions(tc, bumpRuleVersion(RULE), cache).cacheHit).toBe(false);
	expect(getOrAuthorAssertions({ ...tc, contentHash: "changed" }, RULE, cache).cacheHit).toBe(false);
});

test("plan: a provided AI plan replays its actions + assertions and ignores raw steps", async () => {
	const page = new FakePage({ url: "", text: "", html: "" }, loginReducer);
	const tc = loginTC({
		contentHash: "hash-plan",
		steps: ["(free-form prose the deterministic parser could not handle)"],
	});
	const r = await runScenario(tc, {
		page,
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
		plan: {
			actions: [
				{ kind: "goto", path: "/login" },
				{ kind: "fill", target: "Username", value: "viewer" },
				{ kind: "fill", target: "Password", value: "viewer-pass" },
				{ kind: "click", target: "Sign in" },
			],
			assertions: [{ kind: "textIncludes", value: "Signed in as viewer" }],
		},
	});
	expect(r.verdict).toBe("pass");
	expect(r.assertions).toHaveLength(1);
	expect(r.assertions[0]?.passed).toBe(true);
});
