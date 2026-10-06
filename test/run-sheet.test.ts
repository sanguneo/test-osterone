import { describe, expect, test } from "bun:test";
import { exitCodeFor, falsePasses, formatReport, parseArgs, UsageError } from "../src/app/run-sheet.ts";
import type { StructuredResult } from "../src/execute/runner.ts";
import type { NormalizedTC } from "../src/intake/schema.ts";

function result(caseId: string, verdict: StructuredResult["verdict"], checks: boolean[], heal: string[] = []) {
	return {
		schemaVersion: 1,
		caseId,
		executionId: `${caseId}-0`,
		verdict,
		confidence: verdict === "pass" ? 1 : 0,
		assertions: checks.map((passed) => ({
			assertion: { kind: "textIncludes", value: "Welcome" },
			passed,
			detail: passed ? "ok" : "missing",
		})),
		evidenceRefs: [],
		healEvents: heal,
		timing: { ms: 1 },
		ruleVersion: 1,
		scenarioHash: caseId,
		attempts: 1,
		env: { browser: "chromium", viewport: "1280x800", baseUrl: "http://localhost" },
	} as StructuredResult;
}

function tc(caseId: string, sourceId: string | null, title: string): NormalizedTC {
	return {
		caseId,
		sourceId,
		title,
		steps: ["open /"],
		expected: "Welcome",
		priority: null,
		role: null,
		env: null,
		category: null,
		contentHash: caseId,
	};
}

describe("parseArgs", () => {
	test("accepts argv with and without a leading --", () => {
		const plain = parseArgs(["cases.xlsx", "--fixture", "--junit", "out/j.xml"]);
		expect(parseArgs(["--", "cases.xlsx", "--fixture", "--junit", "out/j.xml"])).toEqual(plain);
		expect(plain).toMatchObject({ source: "cases.xlsx", fixture: true, backend: "playwright", junit: "out/j.xml" });
	});

	test("reads url, backend, browser and json", () => {
		expect(
			parseArgs(["s.csv", "--url", "http://app.test/", "--backend", "bsk", "--browser", "edge", "--json", "r.json"]),
		).toMatchObject({ url: "http://app.test", fixture: false, backend: "bsk", browser: "edge", json: "r.json" });
	});

	test.each([
		[["cases.xlsx"]],
		[["cases.xlsx", "--fixture", "--url", "http://x"]],
		[["--fixture"]],
		[["a.xlsx", "b.xlsx", "--fixture"]],
		[["a.xlsx", "--fixture", "--backend", "selenium"]],
		[["a.xlsx", "--fixture", "--junit"]],
		[["a.xlsx", "--fixture", "--nope"]],
		[["a.xlsx", "--url", "not a url"]],
	])("rejects %j as a usage error", (argv) => {
		expect(() => parseArgs(argv)).toThrow(UsageError);
	});
});

describe("false-pass check and exit code", () => {
	test("a pass with a failed assertion or a heal event is a detected false pass", () => {
		const results = [
			result("A", "pass", [true]),
			result("B", "pass", [true, false]),
			result("C", "pass", [true], ["ground: x"]),
			result("D", "fail", [false]),
		];
		expect(falsePasses(results)).toEqual(["B", "C"]);
		expect(exitCodeFor([result("A", "pass", [true]), result("B", "pass", [true, false])])).toBe(1);
	});

	test("0 all pass, 1 any fail/error, 3 only held cases, 2 nothing ran", () => {
		expect(exitCodeFor([result("A", "pass", [true]), result("B", "pass", [true])])).toBe(0);
		expect(exitCodeFor([result("A", "pass", [true]), result("B", "fail", [false])])).toBe(1);
		expect(exitCodeFor([result("A", "error", [])])).toBe(1);
		expect(exitCodeFor([result("A", "fail", [false]), result("B", "needs_review", [])])).toBe(1);
		expect(exitCodeFor([result("A", "pass", [true]), result("B", "needs_review", [true], ["skip: x"])])).toBe(3);
		expect(exitCodeFor([])).toBe(2);
	});
});

describe("formatReport", () => {
	test("prints one row per case with source id, verdict, assertion tally and heal kind", () => {
		const report = formatReport(
			[result("TC-a", "pass", [true]), result("TC-b", "needs_review", [true, false], ["precondition: x"])],
			[tc("TC-a", "TC1", "Valid login"), tc("TC-b", null, "Held case")],
		);
		const lines = report.split("\n");
		expect(lines[2]).toMatch(/^TC1\s+Valid login\s+pass\s+1\/1\s+-$/);
		expect(lines[3]).toMatch(/^TC-b\s+Held case\s+needs_review\s+1\/2\s+precondition$/);
		expect(report).toContain('verdicts   : {"pass":1,"needs_review":1}');
		expect(report).toContain("false-pass : 0 OK");
	});

	test("names the cases of a detected false pass", () => {
		const report = formatReport([result("TC-a", "pass", [false])], [tc("TC-a", "TC1", "x")]);
		expect(report).toContain("false-pass : DETECTED (TC-a)");
	});
});
