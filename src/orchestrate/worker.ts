/**
 * Worker: the same runner artifact exposed over HTTP/JSON. `executeJob` runs one
 * scenario in-process; `createWorkerHandler` wraps it as a fetch handler so a node
 * can act as a host-driven worker (POST /run) or run standalone (call executeJob
 * directly). The page is built worker-side from the job env (BrowserPage in prod,
 * an injected factory in tests) — so a job is plain serializable JSON.
 */

import type { Page } from "../execute/page.ts";
import { type RunEnv, runScenario, type StructuredResult } from "../execute/runner.ts";
import type { NormalizedTC } from "../intake/schema.ts";
import { MemoryAssertionCache } from "../interpret/assertion.ts";
import type { InterpretationRule } from "../interpret/rule.ts";

export interface WorkerJob {
	tc: NormalizedTC;
	rule: InterpretationRule;
	env: RunEnv;
	executionId?: string;
}

export async function executeJob(job: WorkerJob, makePage: (env: RunEnv) => Page): Promise<StructuredResult> {
	return runScenario(job.tc, {
		page: makePage(job.env),
		rule: job.rule,
		cache: new MemoryAssertionCache(),
		env: job.env,
		executionId: job.executionId,
	});
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export function createWorkerHandler(makePage: (env: RunEnv) => Page): (req: Request) => Promise<Response> {
	return async (req) => {
		const url = new URL(req.url);
		if (req.method === "GET" && url.pathname === "/health") return json({ ok: true });
		if (req.method === "POST" && url.pathname === "/run") {
			let job: WorkerJob;
			try {
				job = (await req.json()) as WorkerJob;
			} catch {
				return json({ error: "invalid json" }, 400);
			}
			if (!job?.tc || !job?.rule || !job?.env) return json({ error: "tc, rule, env required" }, 400);
			return json(await executeJob(job, makePage));
		}
		return json({ error: "not found", path: url.pathname }, 404);
	};
}

export function serveWorker(
	makePage: (env: RunEnv) => Page,
	port = 8687,
	hostname = "127.0.0.1",
): ReturnType<typeof Bun.serve> {
	return Bun.serve({ port, hostname, fetch: createWorkerHandler(makePage) });
}
