import { expect, test } from "bun:test";
import type { StructuredResult } from "../src/execute/runner.ts";
import { toJUnitXml } from "../src/report/junit.ts";

function r(over: Partial<StructuredResult>): StructuredResult {
	return {
		schemaVersion: 1,
		caseId: "C",
		executionId: "e",
		verdict: "pass",
		confidence: 1,
		assertions: [],
		evidenceRefs: [],
		healEvents: [],
		timing: { ms: 1000 },
		ruleVersion: 1,
		scenarioHash: "h",
		attempts: 1,
		env: { browser: "b", viewport: "v", baseUrl: "http://x" },
		...over,
	};
}

test("toJUnitXml counts verdicts and emits testcases per verdict kind", () => {
	const xml = toJUnitXml(
		[
			r({ caseId: "P", verdict: "pass" }),
			r({ caseId: "F", verdict: "fail" }),
			r({ caseId: "E", verdict: "error", errorInfo: "boom" }),
			r({ caseId: "N", verdict: "needs_review" }),
		],
		"suite",
	);
	expect(xml).toContain('tests="4"');
	expect(xml).toContain('failures="1"');
	expect(xml).toContain('errors="1"');
	expect(xml).toContain('skipped="1"');
	expect(xml).toContain('<testcase name="P"');
	expect(xml).toContain("<failure");
	expect(xml).toContain("<error");
	expect(xml).toContain("<skipped");
	expect(xml).toContain('time="1.000"');
});

test("toJUnitXml escapes XML metacharacters in names/errors", () => {
	const xml = toJUnitXml([r({ caseId: "a<b>&", verdict: "error", errorInfo: "<bad>" })]);
	expect(xml).toContain("a&lt;b&gt;&amp;");
	expect(xml).not.toContain("<bad>");
});
