import { expect, test } from "bun:test";
import { determinismView, type RunEnv } from "../src/execute/runner.ts";
import type { NormalizedTC } from "../src/intake/schema.ts";
import { establishRuleFromHeaders } from "../src/interpret/rule.ts";
import { httpDispatch, inProcessDispatch, runScenarios } from "../src/orchestrate/host.ts";
import { createWorkerHandler, type WorkerJob } from "../src/orchestrate/worker.ts";
import { makeFixturePage } from "../src/testing/fixture-model.ts";

const RULE = establishRuleFromHeaders(["Test ID", "Title", "Steps", "Expected Result"]);
const ENV: RunEnv = { browser: "fixture-model", viewport: "1280x800", baseUrl: "http://fixture" };

function tc(caseId: string, steps: string[], expected: string, h: string): NormalizedTC {
	return {
		caseId,
		sourceId: caseId,
		title: caseId,
		steps,
		expected,
		priority: null,
		role: null,
		env: "staging",
		contentHash: h,
	};
}

const VIEWER = tc(
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
);
const WRONG = tc(
	"L2",
	[
		"Navigate to /login",
		'Enter "viewer" into "Username"',
		'Enter "bad" into "Password"',
		'Click "Sign in"',
		'Verify page shows "Signed in as viewer"',
	],
	"Signed in as viewer",
	"h2",
);

const job = (t: NormalizedTC): WorkerJob => ({ tc: t, rule: RULE, env: ENV, executionId: "fixed" });

test("in-process and HTTP-worker yield the identical StructuredResult across the process boundary", async () => {
	const inProc = await inProcessDispatch(() => makeFixturePage())(job(VIEWER));
	const server = Bun.serve({ port: 0, fetch: createWorkerHandler(() => makeFixturePage()) });
	try {
		const viaHttp = await httpDispatch(`http://localhost:${server.port}`)(job(VIEWER));
		expect(determinismView(viaHttp)).toEqual(determinismView(inProc));
		expect(viaHttp.verdict).toBe("pass");
		expect(viaHttp.schemaVersion).toBe(1);
	} finally {
		server.stop(true);
	}
});

test("worker handler validates input + reports health", async () => {
	const h = createWorkerHandler(() => makeFixturePage());
	expect((await h(new Request("http://w/health"))).status).toBe(200);
	expect((await h(new Request("http://w/run", { method: "POST", body: "{}" }))).status).toBe(400);
	expect((await h(new Request("http://w/nope"))).status).toBe(404);
});

test("host aggregates across jobs preserving input order under bounded concurrency", async () => {
	const agg = await runScenarios(
		[job(VIEWER), job(WRONG), job(VIEWER)],
		inProcessDispatch(() => makeFixturePage()),
		{
			concurrency: 2,
		},
	);
	expect(agg.total).toBe(3);
	expect(agg.byVerdict.pass).toBe(2);
	expect(agg.byVerdict.fail).toBe(1);
	expect(agg.results[0]?.caseId).toBe("L1");
	expect(agg.results[1]?.caseId).toBe("L2");
	expect(agg.results[2]?.caseId).toBe("L1");
});
