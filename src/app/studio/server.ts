/**
 * test-osterone Studio — a terminal-free, browser-based front door aimed at
 * non-developers. Open it in a browser, paste a Google Sheet of test cases (or
 * click "Run sample"), give the target site URL, and watch the deterministic
 * engine run each case against a REAL headless Chromium and render verdicts,
 * assertions, self-heal events, and the needs_review queue.
 *
 *   bun run studio            # then open http://localhost:8686
 *   node --experimental-transform-types examples/studio/server.ts --selftest
 *
 * Runs under Node because Playwright's browser launch currently hangs under Bun
 * on Windows; it reuses the same deterministic engine as the CLI.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserPage, launchBrowser } from "../../execute/browser-page.ts";
import { runScenario, type Verdict } from "../../execute/runner.ts";
import { csvToRawTable, ingestCsv, ingestGoogleSheet, toCsvExportUrl } from "../../intake/ingest.ts";
import type { NormalizedTC } from "../../intake/schema.ts";
import { MemoryAssertionCache } from "../../interpret/assertion.ts";
import { getOrAuthorPlan, MemoryPlanCache } from "../../interpret/author.ts";
import { establishRuleFromHeaders, type InterpretationRule, refineRule, ruleLint } from "../../interpret/rule.ts";
import { MemoryBaselineStore } from "../../judge/baseline.ts";
import { readCodexLogin, readCodexModel } from "../../model/codex-auth.ts";
import { ApiKeyModelClient, type ModelClient, type ModelMessage } from "../../model/model-client.ts";
import { getCodexAccountId, OAuthProxyModelClient } from "../../model/oauth-proxy.ts";
import { startFixture } from "../../testing/fixture-app.ts";

const here = dirname(fileURLToPath(import.meta.url));
const bundledCases = join(here, "../../testing/sample-cases.csv");
const bundledCasesNl = join(here, "../../testing/sample-cases-nl.csv");

interface CaseView {
	caseId: string;
	title: string;
	verdict: Verdict;
	confidence: number;
	passed: number;
	total: number;
	heal: string[];
	assertions: { detail: string; passed: boolean }[];
}

interface RunView {
	at: number;
	source: string;
	baseUrl: string;
	interpreter: "ai" | "rule";
	counts: Record<Verdict, number>;
	results: CaseView[];
}

export interface RunInput {
	source: "sample" | "sheet";
	sheetUrl?: string;
	baseUrl?: string;
	aiInterpret?: boolean;
}

const history: RunView[] = [];

const DEFAULT_OAUTH_MODEL = "gpt-5.6-sol";
const DEFAULT_APIKEY_MODEL = "gpt-4o-mini";

interface AuthState {
	mode: string;
	accountId?: string;
	model: string;
}
interface AuthInput {
	mode?: "codex" | "token" | "apikey";
	token?: string;
	apiKey?: string;
	model?: string;
}

let modelClient: ModelClient | null = null;
let auth: AuthState | null = null;
// Server-held interpretation rule; AI "rule refine" mutates it and later runs use it.
let rule: InterpretationRule = establishRuleFromHeaders([]);
// Conversation so far, so each refine turn sees prior context (interpretable, iterative).
const refineChat: ModelMessage[] = [];
// AI-authored plans, cached author-once per (case, rule version) so re-runs are deterministic.
const planCache = new MemoryPlanCache();
const baseline = new MemoryBaselineStore();

interface ReviewItem {
	caseId: string;
	title: string;
	verdict: Verdict;
	reason: string;
	url: string;
	text: string;
	screenshot?: string;
	ruleVersion: number;
	env: string;
}
// needs_review (+error) evidence from the latest run, awaiting human approval.
const reviewQueue = new Map<string, ReviewItem>();

// One headless Chromium reused across runs (a fresh context per run) — no per-run cold start.
let browserInstance: Awaited<ReturnType<typeof launchBrowser>> | null = null;
async function sharedBrowser(): Promise<Awaited<ReturnType<typeof launchBrowser>>> {
	if (!browserInstance) browserInstance = await launchBrowser(true);
	return browserInstance;
}

interface Project {
	id: string;
	name: string;
	source: "sample" | "sheet";
	sheetUrl: string;
	baseUrl: string;
	aiInterpret: boolean;
}

const SAMPLE_PROJECT: Project = {
	id: "sample",
	name: "샘플 (번들 데모)",
	source: "sample",
	sheetUrl: "",
	baseUrl: "",
	aiInterpret: false,
};
const projectsFile = join(homedir(), ".test-osterone", "studio-projects.json");

function loadProjects(): Project[] {
	try {
		const raw = JSON.parse(readFileSync(projectsFile, "utf8"));
		return Array.isArray(raw) ? raw.map(sanitizeProject) : [];
	} catch {
		return [];
	}
}
function persistProjects(): void {
	mkdirSync(dirname(projectsFile), { recursive: true });
	writeFileSync(projectsFile, JSON.stringify(userProjects, null, 2));
}
function sanitizeProject(raw: unknown): Project {
	const o = (raw ?? {}) as Record<string, unknown>;
	return {
		id: typeof o.id === "string" && o.id ? o.id : `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
		name: String(o.name ?? "Untitled").slice(0, 80),
		source: o.source === "sheet" ? "sheet" : "sample",
		sheetUrl: String(o.sheetUrl ?? "").slice(0, 500),
		baseUrl: String(o.baseUrl ?? "").slice(0, 300),
		aiInterpret: !!o.aiInterpret,
	};
}
let userProjects: Project[] = loadProjects();
const allProjects = (): Project[] => [SAMPLE_PROJECT, ...userProjects];

function statusPayload(): Record<string, unknown> {
	return {
		connected: !!modelClient,
		auth,
		ruleVersion: rule.ruleVersion,
		intents: rule.intents,
		mapping: rule.mapping,
		warnings: ruleLint(rule),
		chat: refineChat,
	};
}

/** Added/removed trigger phrases per intent between two rules (for an interpretable diff). */
function intentDiff(
	prev: InterpretationRule,
	next: InterpretationRule,
): Record<string, { added: string[]; removed: string[] }> {
	const diff: Record<string, { added: string[]; removed: string[] }> = {};
	for (const kind of Object.keys(next.intents) as (keyof InterpretationRule["intents"])[]) {
		const before = new Set(prev.intents[kind] ?? []);
		const after = new Set(next.intents[kind] ?? []);
		const added = [...after].filter((x) => !before.has(x));
		const removed = [...before].filter((x) => !after.has(x));
		if (added.length || removed.length) diff[kind] = { added, removed };
	}
	return diff;
}

/** Provision a model client from Codex login / pasted token / API key. */
function connect(input: AuthInput): AuthState {
	const mode = input.mode ?? "codex";
	if (mode === "apikey") {
		const apiKey = (input.apiKey ?? "").trim();
		if (!apiKey) throw new Error("API key is required.");
		const model = input.model?.trim() || DEFAULT_APIKEY_MODEL;
		modelClient = new ApiKeyModelClient({ apiKey, model });
		return { mode: "api-key", model };
	}
	let accessToken = (input.token ?? "").trim();
	if (!accessToken && mode === "codex") {
		const login = readCodexLogin();
		if (!login) throw new Error("No local Codex login found — run `codex login`, or paste a token.");
		accessToken = login.accessToken;
	}
	if (!accessToken) throw new Error("Access token is required.");
	const model = input.model?.trim() || (mode === "codex" ? readCodexModel() : undefined) || DEFAULT_OAUTH_MODEL;
	modelClient = new OAuthProxyModelClient({ accessToken, model });
	return { mode: mode === "codex" ? "codex (oauth)" : "oauth token", accountId: getCodexAccountId(accessToken), model };
}

async function loadCases(input: RunInput): Promise<{ cases: NormalizedTC[]; baseUrl: string; stop: () => void }> {
	if (input.source === "sheet") {
		if (!input.sheetUrl) throw new Error("Google Sheet URL is required.");
		const baseUrl = (input.baseUrl ?? "").replace(/\/$/, "");
		if (!baseUrl) throw new Error("Target site URL is required.");
		const { unique } = await ingestGoogleSheet(input.sheetUrl, undefined, rule.mapping);
		if (unique.length === 0) throw new Error("No test cases found in the sheet (check sharing = anyone with link).");
		return { cases: unique, baseUrl, stop: () => {} };
	}
	const fixture = await startFixture();
	const file = input.aiInterpret ? bundledCasesNl : bundledCases;
	return { cases: ingestCsv(readFileSync(file, "utf8")).unique, baseUrl: fixture.url, stop: fixture.stop };
}

/** Ingest → rule → run each case against a real headless browser. Pure engine reuse. */
export async function runBatch(input: RunInput): Promise<RunView> {
	const ai = !!input.aiInterpret;
	if (ai && !modelClient) throw new Error("Connect a model first to use AI step interpretation.");
	const { cases, baseUrl, stop } = await loadCases(input);
	const baselineEnv = input.source === "sample" ? "sample" : baseUrl;
	const caseById = new Map(cases.map((c) => [c.caseId, c]));
	for (const c of cases) reviewQueue.delete(c.caseId);
	const cache = new MemoryAssertionCache();
	const page = await BrowserPage.create({ baseUrl, timeoutMs: 4000, browser: await sharedBrowser() });
	const counts: Record<Verdict, number> = { pass: 0, fail: 0, needs_review: 0, error: 0 };
	const results: CaseView[] = [];
	try {
		for (const tc of cases) {
			const plan = ai && modelClient ? (await getOrAuthorPlan(tc, rule, planCache, modelClient)).plan : undefined;
			const r = await runScenario(tc, {
				page,
				rule,
				cache,
				env: { browser: "chromium", viewport: "1280x800", baseUrl },
				plan,
				baseline,
				baselineEnv,
			});
			if (r.verdict === "needs_review" || r.verdict === "error") {
				const reason = r.healEvents.length
					? `self-heal: ${r.healEvents[0]?.split(":")[0]}`
					: r.verdict === "error"
						? (r.errorInfo ?? "error")
						: r.assertions.length === 0
							? "no assertions authored"
							: "baseline pending approval";
				reviewQueue.set(r.caseId, {
					caseId: r.caseId,
					title: caseById.get(r.caseId)?.title || r.caseId,
					verdict: r.verdict,
					reason,
					url: r.snapshot?.url ?? "",
					text: (r.snapshot?.text ?? "").slice(0, 600),
					screenshot: r.snapshot?.screenshot,
					ruleVersion: r.ruleVersion,
					env: baselineEnv,
				});
			}
			counts[r.verdict] += 1;
			results.push({
				caseId: r.caseId,
				title: tc.title || r.caseId,
				verdict: r.verdict,
				confidence: r.confidence,
				passed: r.assertions.filter((a) => a.passed).length,
				total: r.assertions.length,
				heal: r.healEvents,
				assertions: r.assertions.map((a) => ({ detail: a.detail, passed: a.passed })),
			});
		}
	} finally {
		await page.close();
		stop();
	}
	const view: RunView = {
		at: Date.now(),
		source: input.source,
		baseUrl,
		interpreter: ai ? "ai" : "rule",
		counts,
		results,
	};
	history.unshift(view);
	if (history.length > 20) history.length = 20;
	return view;
}

function send(res: ServerResponse, status: number, body: string, type = "application/json"): void {
	res.writeHead(status, { "content-type": `${type}; charset=utf-8` });
	res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let b = "";
		req.on("data", (c) => {
			b += c;
		});
		req.on("end", () => resolve(b));
	});
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", "http://localhost");
	if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
		return send(res, 200, PAGE, "text/html");
	}
	if (req.method === "GET" && url.pathname === "/api/history") {
		return send(res, 200, JSON.stringify(history));
	}
	if (req.method === "POST" && url.pathname === "/api/run") {
		try {
			const input = JSON.parse((await readBody(req)) || "{}") as RunInput;
			const view = await runBatch(input);
			return send(res, 200, JSON.stringify(view));
		} catch (err) {
			console.error("run failed:", (err as Error).stack ?? err);
			return send(res, 400, JSON.stringify({ error: (err as Error).message }));
		}
	}
	if (req.method === "GET" && url.pathname === "/api/status") {
		return send(res, 200, JSON.stringify(statusPayload()));
	}
	if (req.method === "POST" && url.pathname === "/api/auth") {
		try {
			auth = connect(JSON.parse((await readBody(req)) || "{}") as AuthInput);
			return send(res, 200, JSON.stringify(statusPayload()));
		} catch (err) {
			return send(res, 400, JSON.stringify({ error: (err as Error).message }));
		}
	}
	if (req.method === "POST" && url.pathname === "/api/refine/reset") {
		refineChat.length = 0;
		rule = establishRuleFromHeaders([]);
		return send(res, 200, JSON.stringify(statusPayload()));
	}
	if (req.method === "POST" && url.pathname === "/api/refine") {
		if (!modelClient) return send(res, 400, JSON.stringify({ error: "Connect a model first." }));
		try {
			const { instruction } = JSON.parse((await readBody(req)) || "{}") as { instruction?: string };
			if (!instruction?.trim()) return send(res, 400, JSON.stringify({ error: "Instruction is required." }));
			const prev = rule;
			const result = await refineRule(rule, instruction, modelClient, [...refineChat]);
			rule = result.rule;
			refineChat.push({ role: "user", content: instruction }, { role: "assistant", content: result.message });
			if (refineChat.length > 20) refineChat.splice(0, refineChat.length - 20);
			return send(
				res,
				200,
				JSON.stringify({
					message: result.message,
					changed: result.changed,
					ruleVersion: rule.ruleVersion,
					intents: rule.intents,
					mapping: rule.mapping,
					diff: intentDiff(prev, rule),
					warnings: ruleLint(rule),
					chat: refineChat,
				}),
			);
		} catch (err) {
			console.error("refine failed:", (err as Error).stack ?? err);
			return send(res, 400, JSON.stringify({ error: (err as Error).message }));
		}
	}
	if (req.method === "POST" && url.pathname === "/api/sheet/analyze") {
		if (!modelClient) return send(res, 400, JSON.stringify({ error: "Connect a model first." }));
		try {
			const { sheetUrl } = JSON.parse((await readBody(req)) || "{}") as { sheetUrl?: string };
			if (!sheetUrl?.trim()) return send(res, 400, JSON.stringify({ error: "Sheet URL is required." }));
			const csvRes = await fetch(toCsvExportUrl(sheetUrl));
			if (!csvRes.ok) return send(res, 400, JSON.stringify({ error: `sheet fetch failed: ${csvRes.status}` }));
			const table = csvToRawTable(await csvRes.text());
			if (table.headers.length === 0) return send(res, 400, JSON.stringify({ error: "no headers in sheet" }));
			const sample = table.rows[0] ?? {};
			const instruction =
				`Map this spreadsheet's columns to test-case fields. Set "mapping" to {field: EXACT header name} for any of ` +
				`id,title,step,expected,priority,role,env that a column matches; omit fields with no column. ` +
				`Headers: ${JSON.stringify(table.headers)}. Example row: ${JSON.stringify(sample)}.`;
			const result = await refineRule(rule, instruction, modelClient, [...refineChat]);
			rule = result.rule;
			refineChat.push(
				{ role: "user", content: `시트 해석 요청 · 헤더: ${table.headers.join(", ")}` },
				{ role: "assistant", content: result.message },
			);
			if (refineChat.length > 20) refineChat.splice(0, refineChat.length - 20);
			return send(
				res,
				200,
				JSON.stringify({
					headers: table.headers,
					sample,
					mapping: rule.mapping,
					ruleVersion: rule.ruleVersion,
					message: result.message,
					warnings: ruleLint(rule),
					chat: refineChat,
				}),
			);
		} catch (err) {
			console.error("analyze failed:", (err as Error).stack ?? err);
			return send(res, 400, JSON.stringify({ error: (err as Error).message }));
		}
	}
	if (req.method === "GET" && url.pathname === "/api/review/queue") {
		return send(res, 200, JSON.stringify([...reviewQueue.values()]));
	}
	if (req.method === "POST" && url.pathname === "/api/review/approve") {
		try {
			const { caseId } = JSON.parse((await readBody(req)) || "{}") as { caseId?: string };
			const item = caseId ? reviewQueue.get(caseId) : undefined;
			if (!item) return send(res, 404, JSON.stringify({ error: "unknown case in review queue" }));
			// The run's gate() already proposed a full-text pending baseline; approving flips it.
			baseline.approve(item.caseId, item.ruleVersion, item.env);
			reviewQueue.delete(item.caseId);
			return send(res, 200, JSON.stringify({ approved: true, caseId: item.caseId, queue: [...reviewQueue.values()] }));
		} catch (err) {
			return send(res, 400, JSON.stringify({ error: (err as Error).message }));
		}
	}
	if (req.method === "GET" && url.pathname === "/api/projects") {
		return send(res, 200, JSON.stringify(allProjects()));
	}
	if (req.method === "POST" && url.pathname === "/api/projects") {
		try {
			const p = sanitizeProject(JSON.parse((await readBody(req)) || "{}"));
			if (p.id === "sample") return send(res, 400, JSON.stringify({ error: "cannot modify the sample project" }));
			const idx = userProjects.findIndex((x) => x.id === p.id);
			if (idx >= 0) userProjects[idx] = p;
			else userProjects.push(p);
			persistProjects();
			return send(res, 200, JSON.stringify({ saved: p, projects: allProjects() }));
		} catch (err) {
			return send(res, 400, JSON.stringify({ error: (err as Error).message }));
		}
	}
	if (req.method === "POST" && url.pathname === "/api/projects/delete") {
		const { id } = JSON.parse((await readBody(req)) || "{}") as { id?: string };
		userProjects = userProjects.filter((x) => x.id !== id);
		persistProjects();
		return send(res, 200, JSON.stringify({ projects: allProjects() }));
	}
	return send(res, 404, JSON.stringify({ error: "not found" }));
}

const PAGE = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>test-osterone Studio</title>
<style>
  :root { --bg:#14171c; --panel:#1d2127; --line:#2b313a; --ink:#e7ebf0; --dim:#95a0ad; --lime:#9ee600;
          --pass:#9ee600; --fail:#ff5a52; --review:#ffb020; --error:#7a8794; }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink);
      font:15px/1.5 -apple-system,Segoe UI,Roboto,'Malgun Gothic',sans-serif; }
  header { padding:18px 28px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:14px; }
  header h1 { font-size:18px; margin:0; letter-spacing:.2px; } header .tag { color:var(--dim); font-size:13px; }
  .layout { display:flex; max-width:1080px; margin:0 auto; }
  .side { width:200px; flex-shrink:0; padding:20px 12px; border-right:1px solid var(--line); display:flex; flex-direction:column; gap:4px; }
  .side button { text-align:left; padding:10px 12px; background:none; border:0; color:var(--dim); border-radius:8px; cursor:pointer; font-size:14px; }
  .side button.on { background:#12151a; color:var(--ink); }
  .content { flex:1; min-width:0; padding:24px 22px 60px; }
  section.tab { display:none; } section.tab.active { display:block; }
  h2.sec { font-size:15px; margin:0 0 14px; font-weight:600; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin-bottom:20px; }
  label { display:block; font-size:13px; color:var(--dim); margin:12px 0 6px; }
  input[type=text], select { width:100%; padding:10px 12px; background:#12151a; border:1px solid var(--line);
      border-radius:8px; color:var(--ink); font-size:14px; }
  textarea { width:100%; padding:10px 12px; background:#12151a; border:1px solid var(--line);
      border-radius:8px; color:var(--ink); font-size:14px; font-family:inherit; resize:vertical; }
  .modes { display:flex; gap:10px; } .modes button { flex:1; padding:10px; border:1px solid var(--line); background:#12151a;
      color:var(--dim); border-radius:8px; cursor:pointer; font-size:14px; } .modes button.on { border-color:var(--lime); color:var(--ink); }
  .run { margin-top:16px; padding:12px 20px; background:var(--lime); color:#10130a; border:0; border-radius:8px;
      font-weight:700; font-size:15px; cursor:pointer; } .run:disabled { opacity:.5; cursor:default; }
  .mini { padding:6px 10px; font-size:12px; border:1px solid var(--line); background:#12151a; color:var(--ink); border-radius:6px; cursor:pointer; }
  .plist-item { display:flex; justify-content:space-between; align-items:center; gap:10px; border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin-top:8px; }
  .plist-item .meta { color:var(--dim); font-size:12px; margin-top:2px; }
  .summary { display:flex; gap:10px; flex-wrap:wrap; margin:2px 0 14px; }
  .chip { padding:6px 12px; border-radius:999px; font-size:13px; border:1px solid var(--line); } .chip b { font-variant-numeric:tabular-nums; }
  table { width:100%; border-collapse:collapse; } th,td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.4px; }
  .badge { display:inline-block; padding:2px 9px; border-radius:6px; font-size:12px; font-weight:700; }
  .v-pass{ background:rgba(158,230,0,.16); color:var(--pass);} .v-fail{ background:rgba(255,90,82,.16); color:var(--fail);}
  .v-needs_review{ background:rgba(255,176,32,.16); color:var(--review);} .v-error{ background:rgba(122,135,148,.2); color:var(--error);}
  .detail { color:var(--dim); font-size:12.5px; margin-top:3px; } .detail .x{ color:var(--fail);} .detail .o{ color:var(--pass);}
  .heal { color:var(--review); font-size:12px; } .muted{ color:var(--dim); } .err{ color:var(--fail); }
  code { background:#12151a; padding:1px 6px; border-radius:5px; }
  .rev-item { border:1px solid var(--line); border-radius:10px; padding:12px; margin-top:10px; display:flex; gap:14px; }
  .rev-item img { width:200px; height:auto; border:1px solid var(--line); border-radius:6px; align-self:flex-start; }
  .rev-body { flex:1; min-width:0; } .rev-body .why { color:var(--review); font-size:12.5px; margin:4px 0; }
  .rev-body .txt { color:var(--dim); font-size:12px; white-space:pre-wrap; max-height:96px; overflow:auto; background:#12151a; padding:6px 8px; border-radius:6px; }
  .approve { margin-top:10px; padding:8px 16px; background:var(--lime); color:#10130a; border:0; border-radius:8px; font-weight:700; cursor:pointer; }
  .chatlog { max-height:240px; overflow:auto; margin:10px 0; display:flex; flex-direction:column; gap:8px; }
  .msg { padding:8px 11px; border-radius:8px; font-size:13.5px; max-width:88%; }
  .msg.u { align-self:flex-end; background:#22303a; } .msg.a { align-self:flex-start; background:#12151a; border:1px solid var(--line); }
  .warns { display:flex; flex-wrap:wrap; gap:6px; margin:6px 0; } .warns:empty { margin:0; }
  .warn { font-size:12px; color:var(--review); border:1px solid rgba(255,176,32,.4); border-radius:6px; padding:2px 8px; }
  .linkbtn { background:none; border:0; color:var(--dim); cursor:pointer; font-size:12px; text-decoration:underline; }
  .add { color:var(--pass); } .rem { color:var(--fail); }
</style></head>
<body>
<header><h1>test-osterone <span style="color:var(--lime)">Studio</span></h1>
  <span class="tag">AI가 쓰고, 결정적 엔진이 판정합니다 — 터미널 없이</span></header>
<div class="layout">
  <nav class="side">
    <button data-tab="run" class="on" type="button">실행 &amp; 결과</button>
    <button data-tab="projects" type="button">프로젝트</button>
    <button data-tab="model" type="button">모델 연결 <span id="nav-auth" style="float:right">●</span></button>
    <button data-tab="rules" type="button">AI 규칙 (대화)</button>
    <button data-tab="review" type="button">리뷰 큐 <span id="nav-review" style="float:right;color:var(--review)"></span></button>
  </nav>
  <div class="content">
    <section id="tab-run" class="tab active">
      <h2 class="sec">실행 &amp; 결과</h2>
      <div class="card">
        <label>프로젝트</label>
        <select id="run-project"></select>
        <div id="run-meta" class="muted" style="margin-top:8px;font-size:12.5px"></div>
        <label style="display:flex;align-items:center;gap:8px;margin-top:14px;cursor:pointer">
          <input type="checkbox" id="run-ai" /> <span>AI 스텝 해석 <span class="muted">— 따옴표 없는 자연어 (모델 연결 필요)</span></span>
        </label>
        <button id="run" class="run" type="button">실행</button>
        <span id="status" class="muted" style="margin-left:12px"></span>
      </div>
      <div id="out"></div>
    </section>

    <section id="tab-projects" class="tab">
      <h2 class="sec">프로젝트</h2>
      <div class="card"><div id="proj-list"></div></div>
      <div class="card">
        <b id="proj-editor-title">새 프로젝트</b>
        <input type="hidden" id="proj-id" />
        <label>이름</label><input id="proj-name" type="text" placeholder="예: 우리 서비스 회귀" />
        <div class="modes" style="margin-top:12px">
          <button id="ps-sample" class="on" type="button">샘플</button>
          <button id="ps-sheet" type="button">구글 시트</button>
        </div>
        <div id="proj-sheet-fields" style="display:none">
          <label>구글 시트 URL <span class="muted">(공유: 링크 있는 모든 사용자 · 보기)</span></label>
          <input id="proj-sheet" type="text" placeholder="https://docs.google.com/spreadsheets/d/…" />
          <label>테스트 대상 사이트 URL</label>
          <input id="proj-base" type="text" placeholder="https://your.app" />
        </div>
        <label style="display:flex;align-items:center;gap:8px;margin-top:12px;cursor:pointer">
          <input type="checkbox" id="proj-ai" /> <span>기본으로 AI 스텝 해석 사용</span>
        </label>
        <div style="margin-top:14px;display:flex;gap:10px;align-items:center">
          <button id="proj-save" class="run" type="button" style="margin-top:0">저장</button>
          <button id="proj-new" class="mini" type="button">새로 만들기</button>
          <span id="proj-status" class="muted"></span>
        </div>
      </div>
    </section>

    <section id="tab-model" class="tab">
      <h2 class="sec">모델 연결 <span class="muted" style="font-weight:400;font-size:12px">· AI 규칙 다듬기 / AI 스텝 해석용</span></h2>
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
          <b>연결 방식</b><span id="auth-badge" class="chip muted">미연결</span>
        </div>
        <div class="modes" style="margin-top:12px">
          <button id="a-codex" class="on" type="button">Codex 로그인</button>
          <button id="a-token" type="button">토큰 직접 입력</button>
          <button id="a-key" type="button">API Key</button>
        </div>
        <div id="a-token-f" style="display:none"><label>ChatGPT/Codex 액세스 토큰</label><input id="token" type="text" placeholder="eyJ…" /></div>
        <div id="a-key-f" style="display:none"><label>OpenAI API Key</label><input id="apiKey" type="text" placeholder="sk-…" /></div>
        <button id="connect" class="run" type="button" style="margin-top:14px">연결</button>
        <span id="auth-status" class="muted" style="margin-left:12px"></span>
      </div>
    </section>

    <section id="tab-rules" class="tab">
      <h2 class="sec">AI 규칙 다듬기 (대화)</h2>
      <div class="card">
        <div id="rules-locked" class="muted">먼저 <b>모델 연결</b> 탭에서 모델을 연결하세요.</div>
        <div id="refine-box" style="display:none">
          <div style="margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--line)">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <b>시트 해석 (열 매핑)</b>
              <button id="analyze" class="mini" type="button">선택 프로젝트 시트 AI 해석</button>
            </div>
            <div id="mapping" class="detail" style="margin-top:6px">(매핑 없음)</div>
            <span id="analyze-status" class="muted"></span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <label style="margin:0">지시 <span class="muted">예: "누르기도 click으로", "그건 되돌려"</span></label>
            <button id="refine-reset" type="button" class="linkbtn">초기화</button>
          </div>
          <div id="chat" class="chatlog"></div>
          <div id="warnings" class="warns"></div>
          <div id="intents" class="detail" style="margin-top:8px"></div>
          <div style="display:flex;gap:10px;margin-top:10px;align-items:flex-end">
            <textarea id="instruction" rows="2" placeholder="자연어로 규칙 지시…" style="flex:1"></textarea>
            <button id="refine" class="run" type="button" style="margin-top:0">보내기</button>
          </div>
          <span id="refine-status" class="muted"></span>
        </div>
      </div>
    </section>

    <section id="tab-review" class="tab">
      <h2 class="sec">리뷰 큐</h2>
      <div id="review"></div>
      <div id="review-empty" class="muted">needs_review 케이스가 없습니다. 실행 후 여기서 증거(스크린샷)를 확인하고 baseline을 승인하세요.</div>
    </section>
  </div>
</div>
<script>
  var $ = function(id){ return document.getElementById(id); };
  function esc(s){ var d=document.createElement("div"); d.textContent=s==null?"":String(s); return d.innerHTML; }
  function badge(v){ return '<span class="badge v-'+v+'">'+v+'</span>'; }

  var navs = document.querySelectorAll(".side button");
  for (var n=0;n<navs.length;n++) navs[n].onclick = function(){
    var t = this.getAttribute("data-tab");
    for (var k=0;k<navs.length;k++) navs[k].classList.toggle("on", navs[k].getAttribute("data-tab")===t);
    var secs = document.querySelectorAll("section.tab");
    for (var s=0;s<secs.length;s++) secs[s].classList.toggle("active", secs[s].id==="tab-"+t);
  };

  // ---- projects ----
  var projects = [], selId = "sample", editSource = "sample";
  function fmtSource(p){ return p.source==="sheet" ? ("시트 · "+(p.baseUrl||"대상 미설정")) : "샘플 (번들 데모)"; }
  function fillProjects(list){
    projects = list || [];
    $("run-project").innerHTML = projects.map(function(p){ return '<option value="'+esc(p.id)+'"'+(p.id===selId?" selected":"")+'>'+esc(p.name)+'</option>'; }).join("");
    $("proj-list").innerHTML = projects.map(function(p){
      var actions = p.id==="sample" ? '<span class="muted" style="font-size:12px">기본</span>'
        : '<button class="mini" data-edit="'+esc(p.id)+'">편집</button> <button class="mini" data-del="'+esc(p.id)+'">삭제</button>';
      return '<div class="plist-item"><div><b>'+esc(p.name)+'</b><div class="meta">'+esc(fmtSource(p))+(p.aiInterpret?" · AI 해석":"")+'</div></div><div>'+actions+'</div></div>';
    }).join("");
    var eb=$("proj-list").querySelectorAll("[data-edit]"); for (var i=0;i<eb.length;i++) eb[i].onclick=function(){ editProject(this.getAttribute("data-edit")); };
    var db=$("proj-list").querySelectorAll("[data-del]"); for (var j=0;j<db.length;j++) db[j].onclick=function(){ delProject(this.getAttribute("data-del")); };
    onSelectProject();
  }
  function onSelectProject(){
    selId = $("run-project").value || "sample";
    var p = null; for (var i=0;i<projects.length;i++) if (projects[i].id===selId) p=projects[i];
    if (!p) p = projects[0]; if (!p) return;
    $("run-meta").textContent = "소스: " + fmtSource(p);
    $("run-ai").checked = !!p.aiInterpret;
  }
  $("run-project").onchange = onSelectProject;
  function setEditSource(s){ editSource=s; $("ps-sample").classList.toggle("on",s==="sample"); $("ps-sheet").classList.toggle("on",s==="sheet"); $("proj-sheet-fields").style.display=s==="sheet"?"block":"none"; }
  $("ps-sample").onclick=function(){ setEditSource("sample"); };
  $("ps-sheet").onclick=function(){ setEditSource("sheet"); };
  function newProject(){ $("proj-id").value=""; $("proj-name").value=""; $("proj-sheet").value=""; $("proj-base").value=""; $("proj-ai").checked=false; setEditSource("sample"); $("proj-editor-title").textContent="새 프로젝트"; $("proj-status").className="muted"; $("proj-status").textContent=""; }
  $("proj-new").onclick=newProject;
  function editProject(id){ var p=null; for (var i=0;i<projects.length;i++) if (projects[i].id===id) p=projects[i]; if(!p) return; $("proj-id").value=p.id; $("proj-name").value=p.name; $("proj-sheet").value=p.sheetUrl; $("proj-base").value=p.baseUrl; $("proj-ai").checked=!!p.aiInterpret; setEditSource(p.source); $("proj-editor-title").textContent="프로젝트 편집"; }
  $("proj-save").onclick=async function(){
    var body={ id: $("proj-id").value||undefined, name: $("proj-name").value.trim()||"Untitled", source: editSource, sheetUrl: $("proj-sheet").value.trim(), baseUrl: $("proj-base").value.trim(), aiInterpret: $("proj-ai").checked };
    $("proj-save").disabled=true;
    try { var res=await fetch("/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}); var d=await res.json(); if(!res.ok) throw new Error(d.error||"저장 실패"); selId=d.saved.id; fillProjects(d.projects); $("run-project").value=selId; onSelectProject(); $("proj-status").className="muted"; $("proj-status").textContent="저장됨"; }
    catch(e){ $("proj-status").className="err"; $("proj-status").textContent=e.message; }
    finally { $("proj-save").disabled=false; }
  };
  async function delProject(id){ try { var res=await fetch("/api/projects/delete",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:id})}); var d=await res.json(); if(selId===id) selId="sample"; fillProjects(d.projects); } catch(e){} }

  // ---- run + results ----
  function render(view){
    var c=view.counts, out='<div class="card"><div class="summary">';
    out+='<span class="chip">대상 <b>'+esc(view.baseUrl)+'</b></span>';
    out+='<span class="chip">해석 <b>'+esc(view.interpreter==="ai"?"AI":"규칙")+'</b></span>';
    out+='<span class="chip" style="color:var(--pass)">pass <b>'+(c.pass||0)+'</b></span>';
    out+='<span class="chip" style="color:var(--fail)">fail <b>'+(c.fail||0)+'</b></span>';
    out+='<span class="chip" style="color:var(--review)">needs_review <b>'+(c.needs_review||0)+'</b></span>';
    out+='<span class="chip" style="color:var(--error)">error <b>'+(c.error||0)+'</b></span></div>';
    out+='<table><thead><tr><th>케이스</th><th>판정</th><th>신뢰도</th><th>assert</th><th>상세</th></tr></thead><tbody>';
    view.results.forEach(function(r){
      var det=r.assertions.map(function(a){ return '<div class="detail">'+(a.passed?'<span class="o">✓</span>':'<span class="x">✗</span>')+' '+esc(a.detail)+'</div>'; }).join("");
      if (r.heal && r.heal.length) det+='<div class="heal">⚠ self-heal: '+esc(r.heal.join("; "))+'</div>';
      out+='<tr><td>'+esc(r.title)+'</td><td>'+badge(r.verdict)+'</td><td>'+r.confidence.toFixed(2)+'</td><td>'+r.passed+'/'+r.total+'</td><td>'+(det||'<span class="muted">—</span>')+'</td></tr>';
    });
    out+='</tbody></table></div>';
    $("out").innerHTML=out;
  }
  $("run").onclick=async function(){
    var p=null; for (var i=0;i<projects.length;i++) if (projects[i].id===selId) p=projects[i];
    if(!p) p={source:"sample",sheetUrl:"",baseUrl:""};
    var body={ source:p.source, aiInterpret:$("run-ai").checked, sheetUrl:p.sheetUrl||"", baseUrl:p.baseUrl||"" };
    $("run").disabled=true; $("status").className="muted"; $("status").textContent="실제 브라우저로 실행 중…";
    try { var res=await fetch("/api/run",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}); var data=await res.json(); if(!res.ok) throw new Error(data.error||"실행 실패"); $("status").textContent="완료"; render(data); loadQueue(); }
    catch(e){ $("status").textContent=""; $("out").innerHTML='<div class="card err">오류: '+esc(e.message)+'</div>'; }
    finally { $("run").disabled=false; }
  };

  // ---- model connection ----
  var authMode="codex";
  function setAuthMode(m){ authMode=m; ["codex","token","key"].forEach(function(x){ $("a-"+x).classList.toggle("on", x===m); }); $("a-token-f").style.display=m==="token"?"block":"none"; $("a-key-f").style.display=m==="key"?"block":"none"; }
  $("a-codex").onclick=function(){ setAuthMode("codex"); };
  $("a-token").onclick=function(){ setAuthMode("token"); };
  $("a-key").onclick=function(){ setAuthMode("key"); };
  function renderIntents(v,intents){ $("intents").innerHTML="규칙 v"+v+" · "+Object.keys(intents||{}).map(function(k){ return "<code>"+esc(k)+"</code> "+esc((intents[k]||[]).join(", ")); }).join("&nbsp;&nbsp;"); }
  function renderWarnings(w){ $("warnings").innerHTML=(w||[]).map(function(x){ return '<span class="warn">⚠ '+esc(x)+'</span>'; }).join(""); }
  function renderChat(chat){ $("chat").innerHTML=(chat||[]).map(function(m){ return '<div class="msg '+(m.role==="user"?"u":"a")+'">'+esc(m.content)+'</div>'; }).join(""); $("chat").scrollTop=$("chat").scrollHeight; }
  function diffText(diff){ return Object.keys(diff||{}).map(function(k){ var d=diff[k],s=[]; if(d.added&&d.added.length)s.push('<span class="add">+'+esc(d.added.join(", "))+'</span>'); if(d.removed&&d.removed.length)s.push('<span class="rem">-'+esc(d.removed.join(", "))+'</span>'); return "<code>"+esc(k)+"</code> "+s.join(" "); }).join("&nbsp;&nbsp;"); }
  function renderMapping(m){ var keys=Object.keys(m||{}); $("mapping").innerHTML = keys.length ? keys.map(function(k){ return "<code>"+esc(k)+"</code> → "+esc(m[k]); }).join("&nbsp;&nbsp;") : "(매핑 없음 — 헤더 자동감지 사용)"; }
  function renderStatus(s){
    var on = s.connected && s.auth;
    $("auth-badge").className = on?"chip":"chip muted"; $("auth-badge").style.color = on?"var(--lime)":"";
    $("auth-badge").textContent = on ? ("연결됨 · "+s.auth.mode+(s.auth.accountId?(" · "+s.auth.accountId):"")+" · "+s.auth.model) : "미연결";
    $("nav-auth").style.color = on?"var(--lime)":"var(--dim)";
    $("rules-locked").style.display = on?"none":"block";
    $("refine-box").style.display = on?"block":"none";
    if (s.intents) renderIntents(s.ruleVersion, s.intents);
    renderWarnings(s.warnings); renderChat(s.chat); renderMapping(s.mapping);
  }
  $("connect").onclick=async function(){
    var body={ mode: authMode==="key"?"apikey":(authMode==="token"?"token":"codex"), token:$("token")?$("token").value.trim():"", apiKey:$("apiKey")?$("apiKey").value.trim():"" };
    $("connect").disabled=true; $("auth-status").className="muted"; $("auth-status").textContent="연결 중…";
    try { var res=await fetch("/api/auth",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}); var d=await res.json(); if(!res.ok) throw new Error(d.error||"연결 실패"); $("auth-status").textContent=""; renderStatus(d); }
    catch(e){ $("auth-status").className="err"; $("auth-status").textContent=e.message; }
    finally { $("connect").disabled=false; }
  };
  $("refine-reset").onclick=async function(){ try { var res=await fetch("/api/refine/reset",{method:"POST"}); renderStatus(await res.json()); $("refine-status").textContent=""; } catch(e){ $("refine-status").className="err"; $("refine-status").textContent=e.message; } };
  $("refine").onclick=async function(){
    var ins=$("instruction").value.trim(); if(!ins){ $("refine-status").className="err"; $("refine-status").textContent="지시를 입력하세요."; return; }
    $("refine").disabled=true; $("refine-status").className="muted"; $("refine-status").textContent="AI가 규칙을 다듬는 중…";
    try { var res=await fetch("/api/refine",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({instruction:ins})}); var d=await res.json(); if(!res.ok) throw new Error(d.error||"실패");
      $("instruction").value=""; renderChat(d.chat); renderWarnings(d.warnings); renderIntents(d.ruleVersion,d.intents); renderMapping(d.mapping);
      $("refine-status").className="muted"; $("refine-status").innerHTML=(d.changed?"규칙 v"+d.ruleVersion+" 갱신 · ":"변경 없음 · ")+diffText(d.diff);
    } catch(e){ $("refine-status").className="err"; $("refine-status").textContent=e.message; }
    finally { $("refine").disabled=false; }
  };

  $("analyze").onclick=async function(){
    var p=null; for (var i=0;i<projects.length;i++) if (projects[i].id===selId) p=projects[i];
    if(!p||p.source!=="sheet"||!p.sheetUrl){ $("analyze-status").className="err"; $("analyze-status").textContent="실행 탭에서 시트 프로젝트를 먼저 선택하세요."; return; }
    $("analyze").disabled=true; $("analyze-status").className="muted"; $("analyze-status").textContent="시트 헤더를 AI가 해석하는 중…";
    try { var res=await fetch("/api/sheet/analyze",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sheetUrl:p.sheetUrl})}); var d=await res.json(); if(!res.ok) throw new Error(d.error||"실패");
      renderMapping(d.mapping); renderChat(d.chat); renderWarnings(d.warnings);
      $("analyze-status").className="muted"; $("analyze-status").textContent="헤더: "+(d.headers||[]).join(", ");
    } catch(e){ $("analyze-status").className="err"; $("analyze-status").textContent=e.message; }
    finally { $("analyze").disabled=false; }
  };

  // ---- review queue ----
  function renderQueue(items){
    var nn=(items&&items.length)||0;
    $("nav-review").textContent = nn?("· "+nn):"";
    $("review-empty").style.display = nn?"none":"block";
    if (!nn){ $("review").innerHTML=""; return; }
    var out="";
    items.forEach(function(it){
      out+='<div class="rev-item">';
      if (it.screenshot) out+='<img src="'+it.screenshot+'" alt="screenshot" />';
      out+='<div class="rev-body"><div>'+badge(it.verdict)+' <b>'+esc(it.title)+'</b></div>';
      out+='<div class="why">사유: '+esc(it.reason)+(it.url?' · '+esc(it.url):'')+'</div>';
      out+='<div class="txt">'+esc(it.text||'(빈 페이지)')+'</div>';
      out+='<button class="approve" data-case="'+esc(it.caseId)+'">baseline 승인</button></div></div>';
    });
    $("review").innerHTML=out;
    var btns=$("review").querySelectorAll(".approve"); for (var i=0;i<btns.length;i++) btns[i].onclick=function(){ approve(this.getAttribute("data-case"), this); };
  }
  async function loadQueue(){ try { var res=await fetch("/api/review/queue"); renderQueue(await res.json()); } catch(e){} }
  async function approve(caseId, btn){ if(btn){ btn.disabled=true; btn.textContent="승인 중…"; }
    try { var res=await fetch("/api/review/approve",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({caseId:caseId})}); var d=await res.json(); if(!res.ok) throw new Error(d.error||"승인 실패"); renderQueue(d.queue); }
    catch(e){ if(btn){ btn.disabled=false; btn.textContent="baseline 승인"; } alert(e.message); }
  }

  // init
  fetch("/api/projects").then(function(r){return r.json();}).then(fillProjects).catch(function(){});
  fetch("/api/status").then(function(r){return r.json();}).then(renderStatus).catch(function(){});
  loadQueue();
</script>
</body></html>`;

async function main(): Promise<number> {
	if (process.argv.includes("--selftest")) {
		const view = await runBatch({ source: "sample" });
		console.log("studio selftest — counts:", JSON.stringify(view.counts));
		for (const r of view.results) console.log(`  ${r.verdict.padEnd(13)} ${r.passed}/${r.total}  ${r.title}`);
		const ok = view.counts.pass === 2 && view.counts.fail === 1 && view.counts.needs_review === 1;
		console.log(ok ? "SELFTEST OK" : "SELFTEST MISMATCH");
		await browserInstance?.close();
		return ok ? 0 : 1;
	}
	for (const sig of ["SIGINT", "SIGTERM"] as const) {
		process.on(sig, () => {
			void browserInstance?.close().finally(() => process.exit(0));
		});
	}
	const port = Number(process.env.PORT ?? 8686);
	createServer((req, res) => {
		handle(req, res).catch((err) => send(res, 500, JSON.stringify({ error: String(err) })));
	}).listen(port, () => {
		console.log(`test-osterone Studio → http://localhost:${port}`);
	});
	return 0;
}

main().then((code) => {
	if (code !== 0 || process.argv.includes("--selftest")) process.exit(code);
});
