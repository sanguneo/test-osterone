import { expect, test } from "bun:test";

import { MemoryBaselineStore } from "../src/baseline.ts";
import { createDashboard } from "../src/dashboard.ts";
import { SqliteEvidenceStore } from "../src/evidence.ts";
import type { StructuredResult } from "../src/runner.ts";

function result(over: Partial<StructuredResult>): StructuredResult {
	return {
		schemaVersion: 1,
		caseId: "C1",
		executionId: "e1",
		verdict: "pass",
		confidence: 1,
		assertions: [],
		evidenceRefs: [],
		healEvents: [],
		timing: { ms: 1 },
		ruleVersion: 1,
		scenarioHash: "h",
		attempts: 1,
		env: { browser: "fake", viewport: "1280x800", baseUrl: "http://x" },
		...over,
	};
}

function harness() {
	let t = 0;
	const evidence = new SqliteEvidenceStore(":memory:", () => ++t);
	evidence.recordExecution(result({ executionId: "e1", caseId: "C1", verdict: "pass" }));
	evidence.recordExecution(result({ executionId: "e2", caseId: "C2", verdict: "needs_review", confidence: 0.4 }));
	const baseline = new MemoryBaselineStore(() => 0);
	baseline.propose("C2", 1, "staging", "snapshot");
	return { handler: createDashboard(evidence, baseline), baseline };
}

test("GET /api/executions returns all execution rows", async () => {
	const { handler } = harness();
	const res = await handler(new Request("http://d/api/executions"));
	expect(res.status).toBe(200);
	const rows = (await res.json()) as { caseId: string }[];
	expect(rows).toHaveLength(2);
});

test("GET /api/needs-review returns only needs_review executions", async () => {
	const { handler } = harness();
	const rows = (await (await handler(new Request("http://d/api/needs-review"))).json()) as {
		caseId: string;
		verdict: string;
	}[];
	expect(rows).toHaveLength(1);
	expect(rows[0]?.caseId).toBe("C2");
	expect(rows[0]?.verdict).toBe("needs_review");
});

test("POST /api/baseline/approve approves an existing baseline", async () => {
	const { handler, baseline } = harness();
	const res = await handler(
		new Request("http://d/api/baseline/approve", {
			method: "POST",
			body: JSON.stringify({ caseId: "C2", ruleVersion: 1, env: "staging" }),
		}),
	);
	expect(res.status).toBe(200);
	expect((await res.json()) as { approved: boolean }).toMatchObject({ approved: true });
	expect(baseline.get("C2", 1, "staging")?.approved).toBe(true);
});

test("POST /api/baseline/approve 400 on missing fields, 404 on unknown baseline", async () => {
	const { handler } = harness();
	const bad = await handler(new Request("http://d/api/baseline/approve", { method: "POST", body: JSON.stringify({}) }));
	expect(bad.status).toBe(400);
	const missing = await handler(
		new Request("http://d/api/baseline/approve", {
			method: "POST",
			body: JSON.stringify({ caseId: "NOPE", ruleVersion: 9, env: "staging" }),
		}),
	);
	expect(missing.status).toBe(404);
});

test("GET / renders an HTML run table containing case ids", async () => {
	const { handler } = harness();
	const res = await handler(new Request("http://d/"));
	expect(res.headers.get("content-type")).toContain("text/html");
	const html = await res.text();
	expect(html).toContain("test-osterone runs");
	expect(html).toContain("C1");
	expect(html).toContain("needs_review");
});
