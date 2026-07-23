import { expect, test } from "bun:test";
import type { RunEnv } from "../src/execute/runner.ts";
import type { NormalizedTC } from "../src/intake/schema.ts";
import { establishRuleFromHeaders } from "../src/interpret/rule.ts";
import { evaluateGate, type LabelSet, runBenchmark } from "../src/report/benchmark.ts";
import { makeFixturePage } from "../src/testing/fixture-model.ts";

const RULE = establishRuleFromHeaders(["Test ID", "Title", "Steps", "Expected Result", "Role", "Environment"]);
const ENV: RunEnv = { browser: "fixture-model", viewport: "1280x800", baseUrl: "http://fixture" };

function mkTC(caseId: string, steps: string[], expected: string, contentHash: string): NormalizedTC {
	return {
		caseId,
		sourceId: caseId,
		title: caseId,
		steps,
		expected,
		priority: null,
		role: null,
		env: "staging",
		category: null,
		contentHash,
	};
}

const LABELSET: LabelSet = {
	name: "login-fixture-v1",
	cases: [
		{
			automatable: true,
			expectedVerdict: "pass",
			tc: mkTC(
				"L1",
				[
					"Navigate to /login",
					'Enter "viewer" into "Username"',
					'Enter "viewer-pass" into "Password"',
					'Click "Sign in"',
					'Verify page shows "Signed in as viewer"',
				],
				"Signed in as viewer",
				"h1",
			),
		},
		{
			automatable: true,
			expectedVerdict: "pass",
			tc: mkTC(
				"L2",
				[
					"Navigate to /login",
					'Enter "viewer" into "Username"',
					'Enter "wrong-pass" into "Password"',
					'Click "Sign in"',
					'Verify page shows "Invalid credentials"',
				],
				"Invalid credentials",
				"h2",
			),
		},
		{
			automatable: true,
			expectedVerdict: "pass",
			tc: mkTC(
				"L3",
				[
					"Navigate to /login",
					'Enter "admin" into "Username"',
					'Enter "admin-pass" into "Password"',
					'Click "Sign in"',
					"Navigate to /items",
					'Verify page shows "Widget A"',
				],
				"Widget A",
				"h3",
			),
		},
		// negative: manual/OTP -> not automatable
		{ automatable: false, tc: mkTC("L4", ["Enter the OTP sent to your phone via SMS"], "logged in", "h4") },
		// labeled-fail: a viewer must NOT see admin-only items -> the run should FAIL (false-pass guard)
		{
			automatable: true,
			expectedVerdict: "fail",
			tc: mkTC(
				"L5",
				[
					"Navigate to /login",
					'Enter "viewer" into "Username"',
					'Enter "viewer-pass" into "Password"',
					'Click "Sign in"',
					"Navigate to /items",
					'Verify page shows "Widget A"',
				],
				"Widget A",
				"h5",
			),
		},
	],
};

test("benchmark over the fixture model passes the hard gate (selection/determinism/false-pass)", async () => {
	const score = await runBenchmark(LABELSET, { rule: RULE, env: ENV, makePage: makeFixturePage, k: 5 });
	expect(score.total).toBe(5);
	expect(score.selectionAccuracy).toBe(1); // all 5 triaged correctly
	expect(score.deterministicRate).toBe(1); // K=5 identical for every executed case
	expect(score.falsePass).toBe(0); // L5 labeled-fail correctly fails
	const gate = evaluateGate(score);
	expect(gate.passed).toBe(true);
	expect(gate.failures).toEqual([]);
});

test("labeled-fail case L5 actually reaches verdict fail (no false pass)", async () => {
	const score = await runBenchmark(LABELSET, { rule: RULE, env: ENV, makePage: makeFixturePage, k: 5 });
	const l5 = score.results.find((r) => r.caseId === "L5");
	expect(l5?.verdict).toBe("fail");
	expect(l5?.falsePass).toBe(false);
	const l3 = score.results.find((r) => r.caseId === "L3");
	expect(l3?.verdict).toBe("pass");
});

test("gate fails closed when selection accuracy drops below the bar", async () => {
	const mislabeled: LabelSet = {
		name: "mislabeled",
		cases: LABELSET.cases.map((c) => (c.tc.caseId === "L4" ? { ...c, automatable: true } : c)),
	};
	const score = await runBenchmark(mislabeled, { rule: RULE, env: ENV, makePage: makeFixturePage, k: 3 });
	expect(score.selectionAccuracy).toBeLessThan(0.9); // L4 now mislabeled -> 4/5 = 80%
	const gate = evaluateGate(score);
	expect(gate.passed).toBe(false);
	expect(gate.failures.some((f) => f.includes("selection"))).toBe(true);
});
