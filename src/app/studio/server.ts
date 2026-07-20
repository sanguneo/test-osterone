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
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserPage, launchBrowser } from "../../execute/browser-page.ts";
import { runScenario, type Verdict } from "../../execute/runner.ts";
import {
	csvToRawTable,
	type DedupeResult,
	dedupe,
	ingestCsv,
	mapColumns,
	toCsvExportUrl,
} from "../../intake/ingest.ts";
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

const webDist = join(here, "web/dist");
const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".png": "image/png",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".map": "application/json",
};

/** Serve the built React SPA (web/dist) with an index.html fallback for client routes. */
function serveStatic(res: ServerResponse, pathname: string): void {
	const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
	const file = join(webDist, rel);
	if (!file.startsWith(webDist)) {
		send(res, 403, JSON.stringify({ error: "forbidden" }));
		return;
	}
	try {
		const data = readFileSync(file);
		res.writeHead(200, { "content-type": MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" });
		res.end(data);
	} catch {
		try {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(readFileSync(join(webDist, "index.html")));
		} catch {
			send(res, 404, JSON.stringify({ error: "web UI not built — run 'bun run studio:build'" }));
		}
	}
}

// SheetJS is CJS; load via createRequire so it works under Node without ESM-interop config.
const XLSX = createRequire(import.meta.url)("xlsx") as {
	read: (
		data: Buffer,
		opts: { type: string; sheetRows?: number },
	) => { SheetNames: string[]; Sheets: Record<string, unknown> };
	utils: { sheet_to_csv: (ws: unknown) => string };
};

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

export interface TcSource {
	kind: "sheet" | "csv";
	label: string;
	sheetUrl: string;
	csvText: string;
}
export interface RunInput {
	sample?: boolean;
	sources?: TcSource[];
	baseUrl?: string;
	env?: string;
	username?: string;
	password?: string;
	referenceRepo?: string;
	aiInterpret?: boolean;
	projectId?: string;
}
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

/** Per-project runtime state: interpretation rule, refine conversation, caches, baselines, review queue, history. */
interface ProjectState {
	rule: InterpretationRule;
	refineChat: ModelMessage[];
	planCache: MemoryPlanCache;
	baseline: MemoryBaselineStore;
	reviewQueue: Map<string, ReviewItem>;
	history: RunView[];
}
const projectStates = new Map<string, ProjectState>();
function stateFor(projectId: string): ProjectState {
	let st = projectStates.get(projectId);
	if (!st) {
		st = {
			rule: establishRuleFromHeaders([]),
			refineChat: [],
			planCache: new MemoryPlanCache(),
			baseline: new MemoryBaselineStore(),
			reviewQueue: new Map(),
			history: [],
		};
		projectStates.set(projectId, st);
	}
	return st;
}

// One headless Chromium reused across runs (a fresh context per run) — no per-run cold start.
let browserInstance: Awaited<ReturnType<typeof launchBrowser>> | null = null;
async function sharedBrowser(): Promise<Awaited<ReturnType<typeof launchBrowser>>> {
	if (!browserInstance) browserInstance = await launchBrowser(true);
	return browserInstance;
}

interface Project {
	id: string;
	name: string;
	sources: TcSource[];
	baseUrl: string;
	env: string;
	username: string;
	password: string;
	referenceRepo: string;
	aiInterpret: boolean;
}

const SAMPLE_PROJECT: Project = {
	id: "sample",
	name: "샘플 (번들 데모)",
	sources: [],
	baseUrl: "",
	env: "sample",
	username: "",
	password: "",
	referenceRepo: "",
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
function sanitizeSource(raw: unknown): TcSource {
	const o = (raw ?? {}) as Record<string, unknown>;
	return {
		kind: o.kind === "csv" ? "csv" : "sheet",
		label: String(o.label ?? "").slice(0, 60),
		sheetUrl: String(o.sheetUrl ?? "").slice(0, 500),
		csvText: String(o.csvText ?? "").slice(0, 200000),
	};
}
function sanitizeProject(raw: unknown): Project {
	const o = (raw ?? {}) as Record<string, unknown>;
	let sources: TcSource[] = [];
	if (Array.isArray(o.sources)) sources = o.sources.map(sanitizeSource).slice(0, 20);
	else if (o.source === "sheet" && o.sheetUrl)
		sources = [{ kind: "sheet", label: "시트", sheetUrl: String(o.sheetUrl), csvText: "" }];
	else if (o.source === "csv" && o.csvText)
		sources = [{ kind: "csv", label: "CSV", sheetUrl: "", csvText: String(o.csvText) }];
	return {
		id: typeof o.id === "string" && o.id ? o.id : `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
		name: String(o.name ?? "Untitled").slice(0, 80),
		sources,
		baseUrl: String(o.baseUrl ?? "").slice(0, 300),
		env: String(o.env ?? "").slice(0, 60),
		username: String(o.username ?? "").slice(0, 120),
		password: String(o.password ?? "").slice(0, 200),
		referenceRepo: String(o.referenceRepo ?? "").slice(0, 300),
		aiInterpret: !!o.aiInterpret,
	};
}
let userProjects: Project[] = loadProjects();
const allProjects = (): Project[] => [SAMPLE_PROJECT, ...userProjects];

function statusPayload(projectId: string): Record<string, unknown> {
	const st = stateFor(projectId);
	return {
		connected: !!modelClient,
		auth,
		projectId,
		ruleVersion: st.rule.ruleVersion,
		intents: st.rule.intents,
		mapping: st.rule.mapping,
		warnings: ruleLint(st.rule),
		chat: st.refineChat,
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

async function loadCases(
	input: RunInput,
	mapping: InterpretationRule["mapping"],
): Promise<{ cases: NormalizedTC[]; baseUrl: string; stop: () => void }> {
	if (!input.sample) {
		const baseUrl = (input.baseUrl ?? "").replace(/\/$/, "");
		if (!baseUrl) throw new Error("Target site URL is required.");
		const { unique } = await ingestSources(input.sources ?? [], mapping);
		if (unique.length === 0) throw new Error("No test cases found (add a TC source; check headers / column mapping).");
		return { cases: unique, baseUrl, stop: () => {} };
	}
	const fixture = await startFixture();
	const file = input.aiInterpret ? bundledCasesNl : bundledCases;
	return { cases: ingestCsv(readFileSync(file, "utf8")).unique, baseUrl: fixture.url, stop: fixture.stop };
}

/** Ingest + combine every TC source of a project, then dedupe across all of them. */
async function ingestSources(
	sources: TcSource[],
	mapping: InterpretationRule["mapping"],
): Promise<{ all: NormalizedTC[]; unique: NormalizedTC[]; duplicates: DedupeResult["duplicates"] }> {
	const all: NormalizedTC[] = [];
	for (const s of sources) {
		const text = s.kind === "sheet" ? await ingestGoogleSheetText(s.sheetUrl) : s.csvText;
		if (!text?.trim()) continue;
		all.push(...ingestCsv(text, mapping).all);
	}
	// Drop blank rows (merged/section rows in spreadsheets normalize to empty cases).
	const nonEmpty = all.filter((c) => c.title || c.steps.length > 0 || c.expected);
	return { all: nonEmpty, ...dedupe(nonEmpty) };
}

/** Fetch a public/link-readable Google Sheet as CSV text. */
async function ingestGoogleSheetText(sheetUrl: string): Promise<string> {
	if (!sheetUrl) throw new Error("Google Sheet URL is required.");
	const res = await fetch(toCsvExportUrl(sheetUrl));
	if (!res.ok) throw new Error(`sheet fetch failed: ${res.status} (check sharing = anyone with link)`);
	return res.text();
}

/** Ingest → rule → run each case against a real headless browser. Pure engine reuse. */
export async function runBatch(input: RunInput, onProgress?: (ev: Record<string, unknown>) => void): Promise<RunView> {
	const st = stateFor(input.projectId ?? "sample");
	const ai = !!input.aiInterpret;
	if (ai && !modelClient) throw new Error("Connect a model first to use AI step interpretation.");
	const { cases, baseUrl, stop } = await loadCases(input, st.rule.mapping);
	onProgress?.({ type: "start", total: cases.length, baseUrl, interpreter: ai ? "ai" : "rule" });
	const baselineEnv = input.env?.trim() || (input.sample ? "sample" : baseUrl);
	const caseById = new Map(cases.map((c) => [c.caseId, c]));
	for (const c of cases) st.reviewQueue.delete(c.caseId);
	const cache = new MemoryAssertionCache();
	const page = await BrowserPage.create({ baseUrl, timeoutMs: 4000, browser: await sharedBrowser() });
	const counts: Record<Verdict, number> = { pass: 0, fail: 0, needs_review: 0, error: 0 };
	const results: CaseView[] = [];
	try {
		for (const tc of cases) {
			const plan =
				ai && modelClient
					? (
							await getOrAuthorPlan(tc, st.rule, st.planCache, modelClient, {
								referenceRepo: input.referenceRepo,
								username: input.username,
								password: input.password,
							})
						).plan
					: undefined;
			const r = await runScenario(tc, {
				page,
				rule: st.rule,
				cache,
				env: { browser: "chromium", viewport: "1280x800", baseUrl },
				plan,
				baseline: st.baseline,
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
				st.reviewQueue.set(r.caseId, {
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
			const view: CaseView = {
				caseId: r.caseId,
				title: tc.title || r.caseId,
				verdict: r.verdict,
				confidence: r.confidence,
				passed: r.assertions.filter((a) => a.passed).length,
				total: r.assertions.length,
				heal: r.healEvents,
				assertions: r.assertions.map((a) => ({ detail: a.detail, passed: a.passed })),
			};
			results.push(view);
			onProgress?.({ type: "case", index: results.length - 1, total: cases.length, result: view });
		}
	} finally {
		await page.close();
		stop();
	}
	const view: RunView = {
		at: Date.now(),
		source: input.sample ? "sample" : "project",
		baseUrl,
		interpreter: ai ? "ai" : "rule",
		counts,
		results,
	};
	st.history.unshift(view);
	if (st.history.length > 20) st.history.length = 20;
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
	if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
		return serveStatic(res, url.pathname);
	}
	if (req.method === "GET" && url.pathname === "/api/history") {
		return send(res, 200, JSON.stringify(stateFor(url.searchParams.get("projectId") || "sample").history));
	}
	if (req.method === "POST" && url.pathname === "/api/run") {
		const input = JSON.parse((await readBody(req)) || "{}") as RunInput;
		res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" });
		const emit = (ev: Record<string, unknown>) => res.write(`${JSON.stringify(ev)}\n`);
		try {
			const view = await runBatch(input, emit);
			emit({ type: "done", view });
		} catch (err) {
			console.error("run failed:", (err as Error).stack ?? err);
			emit({ type: "error", error: (err as Error).message });
		}
		res.end();
		return;
	}
	if (req.method === "GET" && url.pathname === "/api/status") {
		return send(res, 200, JSON.stringify(statusPayload(url.searchParams.get("projectId") || "sample")));
	}
	if (req.method === "POST" && url.pathname === "/api/auth") {
		try {
			const body = JSON.parse((await readBody(req)) || "{}") as AuthInput & { projectId?: string };
			auth = connect(body);
			return send(res, 200, JSON.stringify(statusPayload(body.projectId || "sample")));
		} catch (err) {
			return send(res, 400, JSON.stringify({ error: (err as Error).message }));
		}
	}
	if (req.method === "POST" && url.pathname === "/api/refine/reset") {
		const { projectId } = JSON.parse((await readBody(req)) || "{}") as { projectId?: string };
		const pid = projectId || "sample";
		const st = stateFor(pid);
		st.refineChat.length = 0;
		st.rule = establishRuleFromHeaders([]);
		return send(res, 200, JSON.stringify(statusPayload(pid)));
	}
	if (req.method === "POST" && url.pathname === "/api/refine") {
		if (!modelClient) return send(res, 400, JSON.stringify({ error: "Connect a model first." }));
		try {
			const { instruction, projectId } = JSON.parse((await readBody(req)) || "{}") as {
				instruction?: string;
				projectId?: string;
			};
			if (!instruction?.trim()) return send(res, 400, JSON.stringify({ error: "Instruction is required." }));
			const st = stateFor(projectId || "sample");
			const prev = st.rule;
			const result = await refineRule(st.rule, instruction, modelClient, [...st.refineChat]);
			st.rule = result.rule;
			st.refineChat.push({ role: "user", content: instruction }, { role: "assistant", content: result.message });
			if (st.refineChat.length > 20) st.refineChat.splice(0, st.refineChat.length - 20);
			return send(
				res,
				200,
				JSON.stringify({
					message: result.message,
					changed: result.changed,
					ruleVersion: st.rule.ruleVersion,
					intents: st.rule.intents,
					mapping: st.rule.mapping,
					diff: intentDiff(prev, st.rule),
					warnings: ruleLint(st.rule),
					chat: st.refineChat,
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
			const { sheetUrl, csvText, projectId } = JSON.parse((await readBody(req)) || "{}") as {
				sheetUrl?: string;
				csvText?: string;
				projectId?: string;
			};
			const csvSrc = csvText?.trim() ? csvText : sheetUrl?.trim() ? await ingestGoogleSheetText(sheetUrl) : "";
			if (!csvSrc.trim()) return send(res, 400, JSON.stringify({ error: "Sheet URL or CSV is required." }));
			const table = csvToRawTable(csvSrc);
			if (table.headers.length === 0) return send(res, 400, JSON.stringify({ error: "no headers in sheet" }));
			const sample = table.rows[0] ?? {};
			const instruction =
				`Map this spreadsheet's columns to test-case fields. Set "mapping" to {field: EXACT header name} for any of ` +
				`id,title,step,expected,priority,role,env that a column matches; omit fields with no column. ` +
				`Headers: ${JSON.stringify(table.headers)}. Example row: ${JSON.stringify(sample)}.`;
			const st = stateFor(projectId || "sample");
			const result = await refineRule(st.rule, instruction, modelClient, [...st.refineChat]);
			st.rule = result.rule;
			st.refineChat.push(
				{ role: "user", content: `시트 해석 요청 · 헤더: ${table.headers.join(", ")}` },
				{ role: "assistant", content: result.message },
			);
			if (st.refineChat.length > 20) st.refineChat.splice(0, st.refineChat.length - 20);
			return send(
				res,
				200,
				JSON.stringify({
					headers: table.headers,
					sample,
					mapping: st.rule.mapping,
					ruleVersion: st.rule.ruleVersion,
					message: result.message,
					warnings: ruleLint(st.rule),
					chat: st.refineChat,
				}),
			);
		} catch (err) {
			console.error("analyze failed:", (err as Error).stack ?? err);
			return send(res, 400, JSON.stringify({ error: (err as Error).message }));
		}
	}
	if (req.method === "POST" && url.pathname === "/api/tc/preview") {
		try {
			const cfg = JSON.parse((await readBody(req)) || "{}") as RunInput;
			const st = stateFor(cfg.projectId || "sample");
			let headers: string[] = [];
			let all: NormalizedTC[];
			let unique: NormalizedTC[];
			let duplicates: DedupeResult["duplicates"];
			if (cfg.sample) {
				const text = readFileSync(cfg.aiInterpret ? bundledCasesNl : bundledCases, "utf8");
				headers = csvToRawTable(text).headers;
				({ all, unique, duplicates } = ingestCsv(text, st.rule.mapping));
			} else {
				const sources = cfg.sources ?? [];
				if (sources.length === 0) return send(res, 400, JSON.stringify({ error: "TC 소스를 추가하세요." }));
				const first = sources[0];
				const firstText = first
					? first.kind === "sheet"
						? await ingestGoogleSheetText(first.sheetUrl)
						: first.csvText
					: "";
				headers = csvToRawTable(firstText).headers;
				({ all, unique, duplicates } = await ingestSources(sources, st.rule.mapping));
			}
			return send(
				res,
				200,
				JSON.stringify({
					headers,
					mapping: { ...mapColumns(headers), ...st.rule.mapping },
					counts: { total: all.length, unique: unique.length, duplicates: duplicates.length },
					unique: unique.map((c) => ({
						caseId: c.caseId,
						title: c.title,
						steps: c.steps,
						expected: c.expected,
						priority: c.priority,
					})),
					duplicates: duplicates.map((d) => ({
						title: all[d.index]?.title ?? "",
						duplicateOf: all[d.duplicateOfIndex]?.title ?? "",
					})),
				}),
			);
		} catch (err) {
			return send(res, 400, JSON.stringify({ error: (err as Error).message }));
		}
	}
	if (req.method === "POST" && url.pathname === "/api/xlsx/convert") {
		try {
			const { base64 } = JSON.parse((await readBody(req)) || "{}") as { base64?: string };
			if (!base64) return send(res, 400, JSON.stringify({ error: "no file" }));
			const wb = XLSX.read(Buffer.from(base64, "base64"), { type: "buffer", sheetRows: 2000 });
			const sheets = wb.SheetNames.map((name) => {
				const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]).slice(0, 200000);
				const rows = csv.split("\n").filter((l) => l.trim()).length;
				return { name, csv, rows };
			}).filter((s) => s.rows > 1);
			return send(res, 200, JSON.stringify({ sheets }));
		} catch (err) {
			return send(res, 400, JSON.stringify({ error: (err as Error).message }));
		}
	}
	if (req.method === "GET" && url.pathname === "/api/review/queue") {
		const st = stateFor(url.searchParams.get("projectId") || "sample");
		return send(res, 200, JSON.stringify([...st.reviewQueue.values()]));
	}
	if (req.method === "POST" && url.pathname === "/api/review/approve") {
		try {
			const { caseId, projectId } = JSON.parse((await readBody(req)) || "{}") as {
				caseId?: string;
				projectId?: string;
			};
			const st = stateFor(projectId || "sample");
			const item = caseId ? st.reviewQueue.get(caseId) : undefined;
			if (!item) return send(res, 404, JSON.stringify({ error: "unknown case in review queue" }));
			// The run's gate() already proposed a full-text pending baseline; approving flips it.
			st.baseline.approve(item.caseId, item.ruleVersion, item.env);
			st.reviewQueue.delete(item.caseId);
			return send(
				res,
				200,
				JSON.stringify({ approved: true, caseId: item.caseId, queue: [...st.reviewQueue.values()] }),
			);
		} catch (err) {
			return send(res, 400, JSON.stringify({ error: (err as Error).message }));
		}
	}
	if (req.method === "POST" && url.pathname === "/api/review/approve-all") {
		try {
			const { projectId } = JSON.parse((await readBody(req)) || "{}") as { projectId?: string };
			const st = stateFor(projectId || "sample");
			let approved = 0;
			for (const item of [...st.reviewQueue.values()]) {
				st.baseline.approve(item.caseId, item.ruleVersion, item.env);
				st.reviewQueue.delete(item.caseId);
				approved++;
			}
			return send(res, 200, JSON.stringify({ approved, queue: [...st.reviewQueue.values()] }));
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

async function main(): Promise<number> {
	if (process.argv.includes("--selftest")) {
		const view = await runBatch({ sample: true });
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
