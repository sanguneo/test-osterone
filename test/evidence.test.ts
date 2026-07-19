import { expect, test } from "bun:test";

import { SqliteEvidenceStore } from "../src/evidence/evidence.ts";
import type { StructuredResult } from "../src/execute/runner.ts";

function result(over: Partial<StructuredResult> = {}): StructuredResult {
	return {
		schemaVersion: 1,
		caseId: "C1",
		executionId: "e1",
		verdict: "pass",
		confidence: 1,
		assertions: [],
		evidenceRefs: ["evidence/dom-abc"],
		healEvents: [],
		timing: { ms: 5 },
		ruleVersion: 1,
		scenarioHash: "h",
		attempts: 1,
		env: { browser: "fake", viewport: "1280x800", baseUrl: "http://x" },
		...over,
	};
}

test("records and lists executions, most-recent first, per case", () => {
	let t = 0;
	const s = new SqliteEvidenceStore(":memory:", () => ++t);
	s.recordExecution(result({ executionId: "e1", caseId: "C1", verdict: "pass" }));
	s.recordExecution(result({ executionId: "e2", caseId: "C1", verdict: "fail", confidence: 0.5 }));
	s.recordExecution(result({ executionId: "e3", caseId: "C2" }));
	const c1 = s.listExecutions("C1");
	expect(c1).toHaveLength(2);
	expect(c1[0]?.executionId).toBe("e2");
	expect(c1[0]?.verdict).toBe("fail");
	expect(c1[0]?.evidenceRefs).toEqual(["evidence/dom-abc"]);
	expect(s.listExecutions()).toHaveLength(3);
	s.close();
});

test("re-recording the same executionId replaces (idempotent primary key)", () => {
	const s = new SqliteEvidenceStore(":memory:", () => 1);
	s.recordExecution(result({ executionId: "e1", verdict: "pass" }));
	s.recordExecution(result({ executionId: "e1", verdict: "fail" }));
	const rows = s.listExecutions();
	expect(rows).toHaveLength(1);
	expect(rows[0]?.verdict).toBe("fail");
	s.close();
});
