import { expect, test } from "bun:test";
import { FakePage, type PageSnapshot } from "../src/execute/page.ts";
import { type RunOptions, runScenario } from "../src/execute/runner.ts";
import type { NormalizedTC } from "../src/intake/schema.ts";
import { type Assertion, evaluateAssertion, MemoryAssertionCache } from "../src/interpret/assertion.ts";
import { getOrAuthorPlan, MemoryPlanCache, withDerivedAssertions } from "../src/interpret/author.ts";
import { repairAction } from "../src/interpret/repair.ts";
import { establishRuleFromHeaders } from "../src/interpret/rule.ts";
import { MemoryBaselineStore } from "../src/judge/baseline.ts";
import { FakeModelClient } from "../src/model/model-client.ts";

const rule = establishRuleFromHeaders([]);
const tc = (over: Partial<NormalizedTC> = {}): NormalizedTC => ({
	caseId: "TC-soundness",
	sourceId: null,
	title: "Publish",
	steps: [],
	expected: "",
	priority: null,
	role: null,
	env: null,
	category: null,
	contentHash: "soundness",
	...over,
});
const screen = (text: string): PageSnapshot => ({ url: "/app", text, html: `<main>${text}</main>` });
const run = (c: NormalizedTC, page: FakePage, extra: Partial<RunOptions> = {}) =>
	runScenario(c, {
		page,
		rule,
		cache: new MemoryAssertionCache(),
		env: { browser: "fake", viewport: "1280x800", baseUrl: "http://fixture" },
		now: () => 0,
		...extra,
	});

for (const invalid of [{ kind: "upload", target: "Artifact", value: "release.zip" }, { kind: "click" }, null]) {
	test(`invalid authored action is retained as incomplete execution: ${JSON.stringify(invalid)}`, async () => {
		const c = tc({ steps: ["Click Publish", "Upload release.zip"], expected: "Published" });
		const cache = new MemoryPlanCache();
		const model = new FakeModelClient(() =>
			JSON.stringify({
				actions: [{ kind: "click", target: "Publish" }, invalid],
				assertions: [{ kind: "textIncludes", value: "Published" }],
			}),
		);
		for (let i = 0; i < 2; i++) {
			const authored = await getOrAuthorPlan(c, rule, cache, model);
			expect(authored.cacheHit).toBe(i === 1);
			const result = await run(c, new FakePage(screen("Editor"), () => screen("Published")), { plan: authored.plan });
			expect(result.verdict).toBe("needs_review");
			expect(result.executedAsWritten).toBe(false);
			expect(result.healEvents.length).toBeGreaterThan(0);
		}
	});
}

test("an empty plan cannot sign off an actionable written case, even with a baseline", async () => {
	const c = tc({ steps: ["Click Publish"], expected: "Published" });
	const baseline = new MemoryBaselineStore(() => 0);
	baseline.propose(c.caseId, rule.ruleVersion, "test", "Published");
	baseline.approve(c.caseId, rule.ruleVersion, "test");
	const result = await run(c, new FakePage(screen("Published"), (_a, s) => s), {
		plan: { actions: [], assertions: [{ kind: "textIncludes", value: "Published" }] },
		baseline,
		baselineEnv: "test",
	});
	expect(result.verdict).toBe("needs_review");
	expect(result.executedAsWritten).toBe(false);
});

for (const expected of [
	"Saved must appear.\nAudit log must contain the new record.",
	"- Saved must appear.\n- Audit log must contain the new record.",
	"1. Saved must appear. 2. Audit log must contain the new record.",
	"1. Saved must appear in the banner.\n2. Saved must appear in the audit log.",
]) {
	test(`partial expected coverage holds: ${JSON.stringify(expected)}`, async () => {
		const result = await run(
			tc({ steps: ["Click Save"], expected }),
			new FakePage(screen("Editor"), () => screen("Saved")),
			{
				plan: { actions: [{ kind: "click", target: "Save" }], assertions: [{ kind: "textIncludes", value: "Saved" }] },
			},
		);
		expect(result.verdict).toBe("needs_review");
		expect(result.coverage?.total).toBe(2);
		expect(result.coverage?.covered).toBeLessThan(2);
	});
}

test("a field check cannot exempt an unrelated unchecked requirement", async () => {
	const c = tc({
		steps: ["Enter abc into Username", "Click Save"],
		expected: "1. The value must be reflected in the field.\n2. Audit log must contain the new record.",
	});
	const plan = withDerivedAssertions(c, rule, {
		actions: [
			{ kind: "fill", target: "Username", value: "abc" },
			{ kind: "click", target: "Save" },
		],
		assertions: [],
	});
	const result = await run(c, new FakePage(screen("Editor"), (_a, s) => s), { plan });
	expect(result.assertions.every((a) => a.passed)).toBe(true);
	expect(result.verdict).toBe("needs_review");
	expect(result.coverage?.covered).toBeLessThan(2);
});

test("an uncheckable verification step is not silently skipped", async () => {
	const result = await run(
		tc({ steps: ["Navigate to /report", "Verify totals are calculated correctly"], expected: "Report" }),
		new FakePage(screen(""), () => screen("Report")),
	);
	expect(result.verdict).toBe("needs_review");
	expect(result.executedAsWritten).toBe(false);
});

test("a negative verify step cannot become a positive presence assertion", async () => {
	const result = await run(
		tc({ steps: ["Navigate to /report", 'Verify page does not show "Secret"'], expected: "Report" }),
		new FakePage(screen(""), () => screen("Report Secret")),
	);
	expect(result.verdict).not.toBe("pass");
});

test("intermediate presence cannot satisfy a final-state assertion", async () => {
	const c = tc({ steps: ["Click Open", "Click Continue"], expected: "1. The final page must show Approved." });
	const result = await run(
		c,
		new FakePage(screen("Start"), (a) => screen(a.target === "Open" ? "Approved" : "Rejected")),
		{
			plan: {
				actions: [
					{ kind: "click", target: "Open" },
					{ kind: "click", target: "Continue" },
				],
				assertions: [{ kind: "textIncludes", value: "Approved" }],
			},
		},
	);
	expect(result.snapshot?.text).toBe("Rejected");
	expect(result.assertions[0]?.passed).toBe(false);
	expect(result.verdict).not.toBe("pass");
});

for (const [step, value] of [
	["Enter over 12 characters into Username", "abc"],
	["Enter uppercase into Username", "abc"],
]) {
	test(`a restriction needs a challenging stimulus: ${step}`, async () => {
		const c = tc({ steps: [step ?? ""], expected: "1. Input must be rejected." });
		const plan = withDerivedAssertions(c, rule, {
			actions: [{ kind: "fill", target: "Username", value: value ?? "" }],
			assertions: [],
		});
		const result = await run(c, new FakePage(screen("Editor"), (_a, s) => s), { plan });
		expect(result.verdict).toBe("needs_review");
	});
}

for (const [value, actual] of [
	["-100", "100"],
	["1.25", "125"],
	["abc", "xabc"],
	["---", ""],
]) {
	test(`field reflection preserves the actual value: ${value} versus ${actual}`, () => {
		const assertion: Assertion = { kind: "fieldHolds", field: "Value", value: value ?? "" };
		expect(evaluateAssertion(assertion, { ...screen("Editor"), fields: { Value: actual ?? "" } }).passed).toBe(false);
	});
}

test("unresolved written preparation holds before any case action runs", async () => {
	let actions = 0;
	const c = tc({
		precondition: "Customer has one overdue order",
		steps: ["Navigate to /orders"],
		expected: "No orders",
	});
	const result = await run(
		c,
		new FakePage(screen("No orders"), (_a, s) => {
			actions++;
			return s;
		}),
	);
	expect(result.verdict).toBe("needs_review");
	expect(result.executedAsWritten).toBe(false);
	expect(actions).toBe(0);
});

test("an unknown preparation action is not silently skipped", async () => {
	const result = await run(
		tc({ steps: ["Navigate to /report"], expected: "Report" }),
		new FakePage(screen("Report"), (_a, s) => s),
		{
			preparation: [{ kind: "unknown", text: "Create a customer through the API" }],
		},
	);
	expect(result.verdict).toBe("needs_review");
	expect(result.executedAsWritten).toBe(false);
});

test("a failed original retry cannot be lifted by an approved baseline", async () => {
	const c = tc({ steps: ["Click Submit"], expected: "1. Done must appear." });
	const baseline = new MemoryBaselineStore(() => 0);
	baseline.propose(c.caseId, rule.ruleVersion, "test", "Done Help");
	baseline.approve(c.caseId, rule.ruleVersion, "test");
	const tried: string[] = [];
	const page = new FakePage(
		{ url: "/app", text: "Done Help", html: "<main>Done<button>Help</button></main>" },
		(a, s) => {
			tried.push(a.target);
			if (a.target === "Submit") throw new Error("No Submit");
			return s;
		},
	);
	const model = new FakeModelClient(() => JSON.stringify({ kind: "click", target: "Help", when: "before" }));
	const result = await run(c, page, {
		plan: { actions: [{ kind: "click", target: "Submit" }], assertions: [{ kind: "textIncludes", value: "Done" }] },
		repair: (req) => repairAction(model, req),
		baseline,
		baselineEnv: "test",
	});
	expect(tried).toEqual(["Submit", "Help", "Submit"]);
	expect(result.verdict).toBe("needs_review");
	expect(result.executedAsWritten).toBe(false);
	expect(result.baselineLifted).toBeUndefined();
});

test("changing the authoring account invalidates a cached literal credential", async () => {
	const c = tc();
	const cache = new MemoryPlanCache();
	let calls = 0;
	const model = new FakeModelClient((messages) => {
		calls++;
		const text = messages.map((m) => m.content).join("\n");
		return JSON.stringify({
			actions: [{ kind: "fill", target: "Username", value: text.includes("username: alice") ? "alice" : "bob" }],
			assertions: [],
		});
	});
	await getOrAuthorPlan(c, rule, cache, model, { username: "alice" });
	const next = await getOrAuthorPlan(c, rule, cache, model, { username: "bob" });
	expect(next.cacheHit).toBe(false);
	expect(next.plan.actions).toEqual([{ kind: "fill", target: "Username", value: "bob" }]);
	expect(calls).toBe(2);
});

for (const secondStep of ["Upload artifact", "Click Confirm"]) {
	test(`a nonempty model plan cannot omit a written action: ${secondStep}`, async () => {
		const c = tc({ steps: ["Click Save", secondStep], expected: "Saved" });
		const cache = new MemoryPlanCache();
		const model = new FakeModelClient(() =>
			JSON.stringify({
				actions: [{ kind: "click", target: "Save", sourceStep: 1 }],
				assertions: [{ kind: "textIncludes", value: "Saved" }],
			}),
		);
		for (let i = 0; i < 2; i++) {
			const authored = await getOrAuthorPlan(c, rule, cache, model);
			const result = await run(c, new FakePage(screen("Editor"), () => screen("Saved")), { plan: authored.plan });
			expect(result.verdict).toBe("needs_review");
			expect(result.executedAsWritten).toBe(false);
		}
	});
}

test("a fully attributed model plan still passes supported steps", async () => {
	const c = tc({ steps: ["Click Save", "Click Confirm"], expected: "Saved" });
	const model = new FakeModelClient(() =>
		JSON.stringify({
			actions: [
				{ kind: "click", target: "Save", sourceStep: 1 },
				{ kind: "click", target: "Confirm", sourceStep: 2 },
			],
			assertions: [{ kind: "textIncludes", value: "Saved" }],
		}),
	);
	const authored = await getOrAuthorPlan(c, rule, new MemoryPlanCache(), model);
	const result = await run(
		c,
		new FakePage(screen("Editor"), (a) => screen(a.target === "Confirm" ? "Saved" : "Confirming")),
		{ plan: authored.plan },
	);
	expect(result.verdict).toBe("pass");
	expect(result.executedAsWritten).toBe(true);
});

test("a changing field check cannot conceal a pre-existing text assertion", async () => {
	const c = tc({
		steps: ["Enter abc into Username"],
		expected: "1. The value must be reflected in the field.\n2. Published must appear.",
	});
	const plan = withDerivedAssertions(c, rule, {
		actions: [{ kind: "fill", target: "Username", value: "abc" }],
		assertions: [{ kind: "textIncludes", value: "Published" }],
	});
	const result = await run(c, new FakePage(screen("Published"), (_a, s) => s), { plan });
	expect(result.assertions.every((a) => a.passed)).toBe(true);
	expect(result.verdict).toBe("needs_review");
	expect(result.vacuousNote).toBeDefined();
});
