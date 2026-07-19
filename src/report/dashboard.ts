/**
 * Thin web dashboard over the evidence + baseline stores. Read-centric (run
 * history, per-case verdicts, needs_review queue) with a narrow set of approval
 * actions (baseline approve). `createDashboard` returns a pure fetch handler so it
 * is testable without binding a port or a browser; `serveDashboard` wraps it in
 * `Bun.serve` for real use.
 */

import type { SqliteEvidenceStore } from "../evidence/evidence.ts";
import type { MemoryBaselineStore } from "../judge/baseline.ts";

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function esc(s: string): string {
	return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

export function createDashboard(
	evidence: SqliteEvidenceStore,
	baseline: MemoryBaselineStore,
): (req: Request) => Promise<Response> {
	return async (req) => {
		const url = new URL(req.url);
		const path = url.pathname;

		if (req.method === "GET" && path === "/api/executions") {
			return json(evidence.listExecutions(url.searchParams.get("caseId") ?? undefined));
		}
		if (req.method === "GET" && path === "/api/needs-review") {
			return json(evidence.listExecutions().filter((e) => e.verdict === "needs_review"));
		}
		if (req.method === "POST" && path === "/api/baseline/approve") {
			const body = (await req.json().catch(() => ({}))) as { caseId?: string; ruleVersion?: number; env?: string };
			if (!body.caseId || typeof body.ruleVersion !== "number" || !body.env) {
				return json({ error: "caseId, ruleVersion, env required" }, 400);
			}
			try {
				baseline.approve(body.caseId, body.ruleVersion, body.env);
				return json({ approved: true, caseId: body.caseId, ruleVersion: body.ruleVersion, env: body.env });
			} catch (err) {
				return json({ error: (err as Error).message }, 404);
			}
		}
		if (req.method === "GET" && (path === "/" || path === "/index.html")) {
			const rows = evidence
				.listExecutions()
				.slice(0, 50)
				.map(
					(e) =>
						`<tr><td>${esc(e.caseId)}</td><td class="v-${esc(e.verdict)}">${esc(e.verdict)}</td><td>${e.confidence}</td><td>${esc(e.env)}</td></tr>`,
				)
				.join("");
			const body = `<!doctype html><meta charset="utf-8"><title>test-osterone</title><h1>test-osterone runs</h1><table><thead><tr><th>case</th><th>verdict</th><th>confidence</th><th>env</th></tr></thead><tbody>${rows}</tbody></table>`;
			return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
		}
		return json({ error: "not found", path }, 404);
	};
}

export function serveDashboard(
	evidence: SqliteEvidenceStore,
	baseline: MemoryBaselineStore,
	port = 8686,
	hostname = "127.0.0.1",
): ReturnType<typeof Bun.serve> {
	return Bun.serve({ port, hostname, fetch: createDashboard(evidence, baseline) });
}
