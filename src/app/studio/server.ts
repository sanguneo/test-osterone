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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
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
import { describeAssertion, MemoryAssertionCache } from "../../interpret/assertion.ts";
import {
	type AuthoredPlan,
	authorPreparation,
	derivePreparationActions,
	getOrAuthorPlan,
	preparationCacheKey,
	withRowClicks,
} from "../../interpret/author.ts";
import type { PageAction } from "../../interpret/interpret.ts";
import {
	attemptLogin,
	extractStructure,
	type LoginResult,
	type ReconResult,
	reconApp,
	routeTable,
} from "../../interpret/recon.ts";
import { type RepairRequest, repairAction } from "../../interpret/repair.ts";
import { acquireRepo, type RepoReconResult, reconRepo } from "../../interpret/repo-recon.ts";
import {
	type InterpretationRule,
	refineRule,
	ruleLint,
	setRuleCodeContext,
	setRuleContext,
	setRuleRoutes,
} from "../../interpret/rule.ts";
import { visionAssert } from "../../interpret/vision.ts";
import { readCodexLogin, readCodexModel } from "../../model/codex-auth.ts";
import { ApiKeyModelClient, type ModelClient } from "../../model/model-client.ts";
import { getCodexAccountId, OAuthProxyModelClient } from "../../model/oauth-proxy.ts";
import { maybePromptStar } from "../../star-prompt.ts";
import { startFixture } from "../../testing/fixture-app.ts";
import { readModelPin, writeModelPin } from "./model-pin.ts";
import {
	authStepFor,
	endsSignedOut,
	restoreTerminal,
	runModelMeta,
	stalePlaywrightTempDirs,
	summarizeHeal,
	tracesToEvict,
} from "./run-helpers.ts";
import { deleteProjectSheets, deleteSheetContent, readSheetContent, writeSheetContent } from "./sheet-store.ts";
import {
	type CaseView,
	clearSheetRuns,
	deleteProjectState,
	layeredBaseline,
	loadProjectState,
	newProjectState,
	type ProjectState,
	persistProjectState,
	type ReviewItem,
	type RunView,
	resolveSheetId,
	sheetState,
} from "./store.ts";

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
	".ttf": "font/ttf",
	".wasm": "application/wasm",
	".webmanifest": "application/manifest+json",
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

// Playwright's bundled trace-viewer PWA. Serving it from our own origin (below) sidesteps the
// Private Network Access block that stops the public trace.playwright.dev from fetching localhost.
const traceViewerDir = (() => {
	for (const c of [
		join(here, "../../../node_modules/playwright-core/lib/vite/traceViewer"),
		join(process.cwd(), "node_modules/playwright-core/lib/vite/traceViewer"),
	]) {
		if (existsSync(join(c, "index.html"))) return c;
	}
	return null;
})();

/** Serve a file from the bundled Playwright trace viewer (same-origin, so the viewer can fetch our trace.zip). */
function serveTraceViewer(res: ServerResponse, pathname: string): void {
	if (!traceViewerDir) {
		send(res, 404, JSON.stringify({ error: "trace viewer unavailable" }));
		return;
	}
	const sub = pathname.replace(/^\/trace-viewer\/?/, "") || "index.html";
	const file = join(traceViewerDir, sub);
	if (!file.startsWith(traceViewerDir)) {
		send(res, 403, JSON.stringify({ error: "forbidden" }));
		return;
	}
	try {
		const data = readFileSync(file);
		res.writeHead(200, { "content-type": MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" });
		res.end(data);
	} catch {
		send(res, 404, JSON.stringify({ error: "not found" }));
	}
}

// Per-case Playwright traces live here, keyed by project/sheet/case (latest run wins). Served via /api/trace.
const tracesBaseDir = join(homedir(), ".test-osterone", "traces");
const traceSafe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "_");
function tracePathFor(projectId: string, sheetId: string, caseId: string): string {
	return join(tracesBaseDir, traceSafe(projectId), traceSafe(sheetId), `${traceSafe(caseId)}.zip`);
}
/** Directory holding a project's (or a single sheet's) trace zips. */
function traceDirFor(projectId: string, sheetId?: string): string {
	return sheetId
		? join(tracesBaseDir, traceSafe(projectId), traceSafe(sheetId))
		: join(tracesBaseDir, traceSafe(projectId));
}

/** Delete a sheet's oldest trace zips so review evidence cannot grow without bound. */
function pruneTraces(dir: string): void {
	try {
		const files = readdirSync(dir)
			.filter((f) => f.endsWith(".zip"))
			.map((f) => {
				const path = join(dir, f);
				return { path, mtimeMs: statSync(path).mtimeMs };
			});
		for (const path of tracesToEvict(files)) rmSync(path, { force: true });
	} catch {
		// no trace dir yet, or a concurrent run already removed it — nothing to prune
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

export interface Account {
	id: string;
	role: string;
	username: string;
	password: string;
}
export interface TestSheet {
	id: string;
	name: string;
	kind: "sheet" | "csv";
	sheetUrl: string;
	csvText: string;
	baseUrl?: string;
	env?: string;
	mapping?: InterpretationRule["mapping"];
	accountId?: string;
	origin?: "sheet" | "csv" | "xlsx";
}
export interface RunInput {
	sample?: boolean;
	sheets?: TestSheet[];
	/** @deprecated legacy alias for `sheets`; accepted for one release. */
	sources?: TestSheet[];
	sheetId?: string;
	baseUrl?: string;
	env?: string;
	accounts?: Account[];
	referenceRepo?: string;
	aiInterpret?: boolean;
	lenientMatch?: boolean;
	projectId?: string;
	/** Launch a visible (headed) browser window with slowMo so a human can watch the run. */
	headed?: boolean;
}
const DEFAULT_OAUTH_MODEL = "gpt-5.6-sol";
const DEFAULT_APIKEY_MODEL = "gpt-4o-mini";

interface AuthState {
	mode: string;
	accountId?: string;
	model: string;
	reasoning?: string;
	endpoint?: string;
}
interface AuthInput {
	mode?: "codex" | "token" | "apikey";
	token?: string;
	apiKey?: string;
	model?: string;
	reasoning?: string;
	baseUrl?: string;
}

let modelClient: ModelClient | null = null;
let auth: AuthState | null = null;

const projectStates = new Map<string, ProjectState>();
function stateFor(projectId: string): ProjectState {
	let st = projectStates.get(projectId);
	if (!st) {
		st = newProjectState();
		// Sample is an ephemeral bundled demo — never persist it, so selftest determinism holds.
		if (projectId !== "sample") {
			const project = allProjects().find((p) => p.id === projectId);
			const defaultSheetId = resolveSheetId(project);
			loadProjectState(projectId, st, undefined, defaultSheetId);
			if (project) {
				const ids = new Set(project.sheets.map((s) => s.id));
				for (const k of [...st.sheets.keys()]) if (!ids.has(k)) st.sheets.delete(k);
			}
		}
		projectStates.set(projectId, st);
	}
	return st;
}

/** Persist a project's runtime state (best-effort). Sample stays ephemeral. */
function saveState(projectId: string, st: ProjectState): void {
	if (projectId === "sample") return;
	try {
		persistProjectState(projectId, st);
	} catch (err) {
		console.error("state persist failed:", (err as Error).message);
	}
}

// One headless Chromium reused across runs (a fresh context per run) — no per-run cold start.
let browserInstance: Awaited<ReturnType<typeof launchBrowser>> | null = null;
async function sharedBrowser(): Promise<Awaited<ReturnType<typeof launchBrowser>>> {
	if (!browserInstance) browserInstance = await launchBrowser(true);
	return browserInstance;
}

/**
 * Playwright deletes its trace scratch dir when the context closes, so a killed process leaves it
 * behind — and tracing buffers every screencast frame there for the whole context lifetime (one
 * killed 640-case sweep left a single 13GB directory). Reap dead runs' leftovers at startup.
 */
function sweepPlaywrightTemp(): void {
	const dir = tmpdir();
	try {
		const entries = readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => ({ name: e.name, mtimeMs: statSync(join(dir, e.name)).mtimeMs }));
		let reaped = 0;
		for (const name of stalePlaywrightTempDirs(entries, Date.now())) {
			rmSync(join(dir, name), { recursive: true, force: true });
			reaped++;
		}
		if (reaped > 0) console.log(`temp: reaped ${reaped} orphaned Playwright trace dir(s)`);
	} catch {
		// unreadable temp dir, or a racing process holding a lock — never worth failing startup over
	}
}

/**
 * Terminal restoration bound to this process. Shared by the shutdown path and the top-level
 * failure handler, so no exit route can skip it.
 *
 * The streams are read on each call rather than captured: `setRawMode` has to stay bound to the
 * real stdin stream, and touching the getters early would initialize stdin before we need it.
 */
function restoreProcessTerminal(): void {
	restoreTerminal({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, writeSync });
}

/** Close the shared browser so Playwright removes its scratch dirs on a normal shutdown. */
async function shutdownBrowser(): Promise<void> {
	const browser = browserInstance;
	browserInstance = null;
	await browser?.close().catch(() => {});
}

interface Project {
	id: string;
	name: string;
	sheets: TestSheet[];
	baseUrl: string;
	env: string;
	accounts: Account[];
	referenceRepo: string;
	aiInterpret: boolean;
	lenientMatch: boolean;
}

const SAMPLE_PROJECT: Project = {
	id: "sample",
	name: "샘플 (번들 데모)",
	sheets: [{ id: "sample-sheet", name: "샘플 케이스", kind: "csv", sheetUrl: "", csvText: "" }],
	baseUrl: "",
	env: "sample",
	accounts: [],
	referenceRepo: "",
	aiInterpret: false,
	lenientMatch: false,
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
const SHEET_MAP_FIELDS = new Set(["id", "title", "step", "expected", "priority", "role", "env"]);
function sanitizeSheetMapping(raw: unknown): InterpretationRule["mapping"] {
	const o = (raw ?? {}) as Record<string, unknown>;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(o)) {
		if (SHEET_MAP_FIELDS.has(k) && typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 60);
	}
	return out as InterpretationRule["mapping"];
}
function sanitizeSheet(raw: unknown): TestSheet {
	const o = (raw ?? {}) as Record<string, unknown>;
	const kind = o.kind === "csv" ? "csv" : "sheet";
	const sheet: TestSheet = {
		id: typeof o.id === "string" && o.id ? o.id : `sh_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
		name: String(o.name ?? o.label ?? (kind === "sheet" ? "시트" : "CSV")).slice(0, 60),
		kind,
		sheetUrl: String(o.sheetUrl ?? "").slice(0, 500),
		csvText: String(o.csvText ?? "").slice(0, 200000),
	};
	const baseUrl = String(o.baseUrl ?? "")
		.slice(0, 300)
		.trim();
	if (baseUrl) sheet.baseUrl = baseUrl;
	const env = String(o.env ?? "")
		.slice(0, 60)
		.trim();
	if (env) sheet.env = env;
	if (typeof o.accountId === "string" && o.accountId) sheet.accountId = o.accountId;
	if (o.origin === "sheet" || o.origin === "csv" || o.origin === "xlsx") sheet.origin = o.origin;
	const mapping = sanitizeSheetMapping(o.mapping);
	if (Object.keys(mapping).length) sheet.mapping = mapping;
	return sheet;
}
function sanitizeAccounts(raw: unknown, legacyUser?: unknown, legacyPass?: unknown): Account[] {
	const out: Account[] = [];
	if (Array.isArray(raw)) {
		for (const item of raw) {
			const o = (item ?? {}) as Record<string, unknown>;
			const username = String(o.username ?? "")
				.slice(0, 200)
				.trim();
			const password = String(o.password ?? "").slice(0, 200);
			if (!username && !password) continue;
			out.push({
				id: typeof o.id === "string" && o.id ? o.id : `acct_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
				role: String(o.role ?? "")
					.slice(0, 60)
					.trim(),
				username,
				password,
			});
		}
	}
	if (out.length === 0) {
		const u = String(legacyUser ?? "").trim();
		const p = String(legacyPass ?? "");
		if (u || p) out.push({ id: `acct_${Date.now()}_mig`, role: "", username: u, password: p });
	}
	return out;
}
function sanitizeProject(raw: unknown): Project {
	const o = (raw ?? {}) as Record<string, unknown>;
	let sheets: TestSheet[] = [];
	if (Array.isArray(o.sheets)) sheets = o.sheets.map(sanitizeSheet);
	else if (Array.isArray(o.sources))
		sheets = o.sources.map((s, i) => {
			const sh = sanitizeSheet(s);
			const so = (s ?? {}) as Record<string, unknown>;
			if (!(typeof so.id === "string" && so.id)) sh.id = `sh_mig_${i}`;
			return sh;
		});
	else if (o.source === "sheet" && o.sheetUrl)
		sheets = [sanitizeSheet({ id: "sh_mig_0", kind: "sheet", name: "시트", sheetUrl: String(o.sheetUrl) })];
	else if (o.source === "csv" && o.csvText)
		sheets = [sanitizeSheet({ id: "sh_mig_0", kind: "csv", name: "CSV", csvText: String(o.csvText) })];
	return {
		id: typeof o.id === "string" && o.id ? o.id : `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
		name: String(o.name ?? "Untitled").slice(0, 80),
		sheets,
		baseUrl: String(o.baseUrl ?? "").slice(0, 300),
		env: String(o.env ?? "").slice(0, 60),
		accounts: sanitizeAccounts(o.accounts, o.username, o.password),
		referenceRepo: String(o.referenceRepo ?? "").slice(0, 300),
		aiInterpret: !!o.aiInterpret,
		lenientMatch: !!o.lenientMatch,
	};
}
let userProjects: Project[] = loadProjects();
const allProjects = (): Project[] => [SAMPLE_PROJECT, ...userProjects];
try {
	let _migrated = false;
	for (const proj of userProjects) {
		if (proj.id === "sample") continue;
		for (const sh of proj.sheets) {
			if (sh.kind === "csv" && sh.csvText) {
				writeSheetContent(proj.id, sh.id, sh.csvText);
				sh.csvText = "";
				_migrated = true;
			}
		}
	}
	if (_migrated) persistProjects();
} catch (err) {
	console.error("sheet content migration failed:", (err as Error).message);
}

function statusPayload(projectId: string, sheetId?: string): Record<string, unknown> {
	const st = stateFor(projectId);
	const project = allProjects().find((p) => p.id === projectId);
	const sid = resolveSheetId(project, sheetId);
	const ss = sheetState(st, sid);
	return {
		connected: !!modelClient,
		codexAvailable: !!readCodexLogin(),
		auth,
		projectId,
		ruleVersion: ss.rule.ruleVersion,
		intents: ss.rule.intents,
		mapping: ss.rule.mapping,
		warnings: ruleLint(ss.rule),
		chat: ss.refineChat,
		appContext: ss.rule.appContext ?? "",
		codeContext: ss.rule.codeContext ?? "",
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

const REASONING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const CHAT_REASONING_LEVELS = new Set(["minimal", "low", "medium", "high"]);
function normReasoning(v?: string): string | undefined {
	const t = (v ?? "").trim();
	return REASONING_LEVELS.has(t) ? t : undefined;
}

/** Provision a model client from Codex login / pasted token / API key. */
function connect(input: AuthInput): AuthState {
	const mode = input.mode ?? "codex";
	const reasoning = normReasoning(input.reasoning);
	if (mode === "apikey") {
		const apiKey = (input.apiKey ?? "").trim();
		if (!apiKey) throw new Error("API key is required.");
		const model = input.model?.trim() || DEFAULT_APIKEY_MODEL;
		const baseUrl = input.baseUrl?.trim() || undefined;
		const apiReasoning = reasoning && CHAT_REASONING_LEVELS.has(reasoning) ? reasoning : undefined;
		modelClient = new ApiKeyModelClient({ apiKey, model, baseUrl, reasoning: apiReasoning });
		return { mode: "api-key", model, endpoint: baseUrl ?? "https://api.openai.com/v1", reasoning: apiReasoning };
	}
	let accessToken = (input.token ?? "").trim();
	if (!accessToken && mode === "codex") {
		const login = readCodexLogin();
		if (!login) throw new Error("로컬 Codex 세션이 없습니다 — 브라우저 로그인을 실행하거나 토큰을 붙여넣으세요.");
		accessToken = login.accessToken;
	}
	if (!accessToken) throw new Error("Access token is required.");
	const model = input.model?.trim() || (mode === "codex" ? readCodexModel() : undefined) || DEFAULT_OAUTH_MODEL;
	modelClient = new OAuthProxyModelClient({ accessToken, model, reasoning });
	return {
		mode: mode === "codex" ? "codex (oauth)" : "oauth token",
		accountId: getCodexAccountId(accessToken),
		model,
		reasoning,
	};
}

// --- Native OpenAI/ChatGPT device-code login (no codex CLI required; ported from gajae-code openai-codex OAuth) ---
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEVICE_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const DEVICE_AUTH_URL = "https://auth.openai.com/codex/device";

interface DevicePending {
	deviceAuthId: string;
	userCode: string;
	model?: string;
	reasoning?: string;
}
let devicePending: DevicePending | null = null;

async function exchangeDeviceCode(code: string, verifier: string): Promise<string> {
	const res = await fetch(OPENAI_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: OPENAI_CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: DEVICE_REDIRECT_URI,
		}),
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) throw new Error(`토큰 교환 실패: ${res.status} ${(await res.text()).slice(0, 200)}`);
	const data = (await res.json()) as { access_token?: string };
	if (!data.access_token) throw new Error("토큰 응답에 access_token이 없습니다.");
	return data.access_token;
}

/** Start OpenAI device-code login: returns the user code + verification URL for the browser step. */
async function startDeviceLogin(model?: string, reasoning?: string): Promise<{ userCode: string; url: string }> {
	const res = await fetch(DEVICE_USERCODE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: OPENAI_CLIENT_ID }),
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) throw new Error(`디바이스 인증 시작 실패: ${res.status}`);
	const data = (await res.json()) as { device_auth_id?: string; user_code?: string };
	if (!data.device_auth_id || !data.user_code) throw new Error("디바이스 인증 응답이 올바르지 않습니다.");
	devicePending = { deviceAuthId: data.device_auth_id, userCode: data.user_code, model, reasoning };
	return { userCode: data.user_code, url: DEVICE_AUTH_URL };
}

/** Poll the device-code endpoint once. Returns "pending", or an AuthState (and sets modelClient) on success. */
async function pollDeviceLogin(): Promise<AuthState | "pending"> {
	if (!devicePending) throw new Error("진행 중인 로그인이 없습니다. 다시 시작하세요.");
	const res = await fetch(DEVICE_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ device_auth_id: devicePending.deviceAuthId, user_code: devicePending.userCode }),
		signal: AbortSignal.timeout(15_000),
	});
	if (res.status === 403 || res.status === 404) return "pending";
	if (!res.ok) throw new Error(`로그인 확인 실패: ${res.status}`);
	const data = (await res.json()) as { authorization_code?: string; code_verifier?: string };
	if (!data.authorization_code || !data.code_verifier) return "pending";
	const accessToken = await exchangeDeviceCode(data.authorization_code, data.code_verifier);
	const reasoning = normReasoning(devicePending.reasoning);
	const model = devicePending.model?.trim() || readCodexModel() || DEFAULT_OAUTH_MODEL;
	modelClient = new OAuthProxyModelClient({ accessToken, model, reasoning });
	devicePending = null;
	return { mode: "chatgpt (oauth)", accountId: getCodexAccountId(accessToken), model, reasoning };
}

/** Fill in a CSV sheet's content from its offloaded file when the caller sent it empty (metadata only). */
function hydrateSheets(projectId: string, sheets: TestSheet[]): TestSheet[] {
	return sheets.map((s) => (s.kind === "csv" && !s.csvText ? { ...s, csvText: readSheetContent(projectId, s.id) } : s));
}
async function loadCases(
	input: RunInput,
	mapping: InterpretationRule["mapping"],
): Promise<{ cases: NormalizedTC[]; baseUrl: string; stop: () => void }> {
	if (!input.sample) {
		const baseUrl = (input.baseUrl ?? "").replace(/\/$/, "");
		if (!baseUrl) throw new Error("Target site URL is required.");
		const sheets = hydrateSheets(input.projectId ?? "sample", input.sheets ?? input.sources ?? []);
		const { unique } = await ingestSources(sheets, mapping);
		if (unique.length === 0) throw new Error("No test cases found (add a TC source; check headers / column mapping).");
		return { cases: unique, baseUrl, stop: () => {} };
	}
	const fixture = await startFixture();
	const file = input.aiInterpret ? bundledCasesNl : bundledCases;
	return { cases: ingestCsv(readFileSync(file, "utf8")).unique, baseUrl: fixture.url, stop: fixture.stop };
}

/** Ingest a sheet's source and dedupe within it (per-sheet). */
async function ingestSources(
	sources: TestSheet[],
	mapping: InterpretationRule["mapping"],
): Promise<{ all: NormalizedTC[]; unique: NormalizedTC[]; duplicates: DedupeResult["duplicates"] }> {
	const all: NormalizedTC[] = [];
	for (const s of sources) {
		const text = s.kind === "sheet" ? await ingestGoogleSheetText(s.sheetUrl) : s.csvText;
		if (!text?.trim()) continue;
		all.push(...ingestCsv(text, mapping).all);
	}
	// Cross-sheet dedupe; each sheet already dropped its blank/section rows during ingest.
	return { all, ...dedupe(all) };
}

/** Fetch a public/link-readable Google Sheet as CSV text. */
async function ingestGoogleSheetText(sheetUrl: string): Promise<string> {
	if (!sheetUrl) throw new Error("Google Sheet URL is required.");
	const res = await fetch(toCsvExportUrl(sheetUrl));
	if (!res.ok) throw new Error(`sheet fetch failed: ${res.status} (check sharing = anyone with link)`);
	return res.text();
}

/** Ingest → rule → run each case against a real headless browser. Pure engine reuse. */
export async function runBatch(
	input: RunInput,
	onProgress?: (ev: Record<string, unknown>) => void,
	signal?: AbortSignal,
): Promise<RunView> {
	const startedAt = Date.now();
	const st = stateFor(input.projectId ?? "sample");
	let ai = !!input.aiInterpret;
	// No model connected → don't hard-fail; fall back to rule interpretation and tell the client.
	const aiUnavailable = ai && !modelClient;
	if (aiUnavailable) ai = false;
	// Vision fallback for image/color expectations — only when a model is connected (AI runs).
	let visionFn: ((screenshot: string, expected: string) => Promise<boolean>) | undefined;
	if (ai && modelClient) {
		const mc = modelClient;
		visionFn = (screenshot, expected) => visionAssert(mc, screenshot, expected);
	}
	const project = allProjects().find((p) => p.id === (input.projectId ?? "sample"));
	const sheet = input.sheets?.[0];
	const accounts = input.accounts ?? [];
	const defaultAccount = accounts.find((a) => a.id === sheet?.accountId) ?? accounts[0];
	const sid = input.sheetId ?? resolveSheetId(project, input.sheetId) ?? "__default__";
	const sheetSt = sheetState(st, sid);
	const effMapping = { ...sheetSt.rule.mapping, ...(sheet?.mapping ?? {}) };
	const runInput: RunInput = { ...input, aiInterpret: ai, baseUrl: sheet?.baseUrl || input.baseUrl };
	const { cases, baseUrl, stop } = await loadCases(runInput, effMapping);
	onProgress?.({ type: "start", total: cases.length, baseUrl, interpreter: ai ? "ai" : "rule" });
	if (aiUnavailable)
		onProgress?.({ type: "notice", message: "모델 미연결 — AI 스텝 해석 대신 규칙 해석으로 실행합니다." });
	const baselineEnv = (sheet?.env || input.env)?.trim() || (input.sample ? "sample" : baseUrl);
	const caseById = new Map(cases.map((c) => [c.caseId, c]));
	for (const c of cases) sheetSt.reviewQueue.delete(c.caseId);
	const cache = new MemoryAssertionCache();
	const trace = !input.sample; // capture Playwright traces for real runs (sample stays ephemeral)
	const counts: Record<Verdict, number> = { pass: 0, fail: 0, needs_review: 0, error: 0 };
	const results: CaseView[] = [];
	/**
	 * Close out the run: stamp what produced it, then persist it as this sheet's latest history
	 * entry. `model`/`reasoning`/`durationMs` are recorded because counts alone make two runs of
	 * the same sheet indistinguishable — comparing models or reasoning levels afterwards needs to
	 * know which one produced which verdicts, and how long it took.
	 */
	const finish = (): RunView => {
		const view: RunView = {
			at: startedAt,
			source: input.sample ? "sample" : "project",
			baseUrl,
			interpreter: ai ? "ai" : "rule",
			...runModelMeta(ai ? "ai" : "rule", auth),
			durationMs: Date.now() - startedAt,
			counts,
			results,
			sheetId: sid,
		};
		if (!signal?.aborted) {
			sheetSt.history.unshift(view);
			if (sheetSt.history.length > 20) sheetSt.history.length = 20;
			saveState(input.projectId ?? "sample", st);
		}
		return view;
	};
	// Nothing to execute (empty sheet, or every row filtered out). Launching Chromium and creating
	// a trace directory to run zero cases is pure cost, and on a machine with no browser installed
	// it turns an empty run into a browser-install error.
	if (cases.length === 0) {
		stop();
		return finish();
	}
	// The sheet's vocabulary follows the browser: the adapter reads words too (which trailing noun is a
	// UI kind, what a blocking notice calls its close control), and those were the last two lists living
	// in code instead of on the rule.
	const phrases = sheetSt.rule.phrases;
	const page = input.headed
		? await BrowserPage.create({ baseUrl, timeoutMs: 4000, headless: false, slowMo: 300, trace, phrases })
		: await BrowserPage.create({ baseUrl, timeoutMs: 4000, browser: await sharedBrowser(), trace, phrases });
	if (trace)
		mkdirSync(join(tracesBaseDir, traceSafe(input.projectId ?? "sample"), traceSafe(sid)), { recursive: true });
	// Cancellation: closing the page interrupts any in-flight Playwright action so the run stops promptly.
	signal?.addEventListener(
		"abort",
		() => {
			void page.close().catch(() => {});
		},
		{ once: true },
	);
	try {
		// --- Session ownership -----------------------------------------------------------------
		// Every case shares one browser session, so the runner — not the cases — decides who is
		// signed in. Three rules: an auth-feature case starts signed out (otherwise there is no
		// login form to test); every other case starts signed in **as its own role account**
		// (routing a role to credentials the plan merely reads is not the same as being that user);
		// a logout case leaves the session dead, so the next case signs back in.
		//
		// Sign-in is LAZY on purpose: validating the login page must not be preceded by a login.
		// An eager precondition would authenticate, then immediately throw that session away for the
		// first 로그인 case — a wasted round trip, and a login form the run never actually meets.
		const hasCreds = (a?: Account): a is Account => !!a && !!(a.username || a.password);
		/** Sign in. The retry (and the rule that a refused credential is never re-submitted) lives in
		 * `attemptLogin`, so recon gets the same behaviour instead of only the runner having it. */
		const signIn = (acct: Account): Promise<LoginResult> =>
			attemptLogin(
				page,
				{ username: acct.username, password: acct.password },
				{
					// Batch patience: a login that takes 12 seconds tonight is not a finding about the app,
					// and the 6s default reads it as a failed attempt — two of those open the breaker and
					// the batch runs on signed out. The batch can afford to wait; a recon probe cannot.
					settleTimeoutMs: 15000,
					onRetry: (note) =>
						onProgress?.({
							type: "notice",
							message: `로그인 재시도(${acct.username || acct.role || acct.id}) — ${note}`,
						}),
				},
			);
		/** Account id the browser is currently authenticated as; null means signed out / unknown. */
		let signedInAs: string | null = null;
		/** Consecutive sign-in failures; reset by a success. `authStepFor` decides what they mean. */
		let failedSignIns = 0;
		/** The app showed a wrong-credentials message — resubmitting risks a lockout. Permanent. */
		let credentialRefused = false;
		/** Cases seen since the last sign-in attempt — the half-open retry window's clock. */
		let casesSinceAttempt = 0;
		let signedInEver = false;
		/** Make the live session match `want`, signing the previous user out first when they differ. */
		const ensureSignedInAs = async (want: Account, why: string): Promise<void> => {
			if (signedInAs === want.id) return;
			casesSinceAttempt = 0;
			if (signedInAs !== null) await page.resetSession().catch(() => {});
			const res = await signIn(want);
			signedInAs = res.ok ? want.id : null;
			const who = want.role || want.username || want.id;
			if (!res.ok) {
				failedSignIns++;
				if (res.rejected) credentialRefused = true;
				// Nothing ever authenticated: the credentials or the app are wrong, and every remaining
				// case would fail into the review queue one by one. Stop the batch with the real reason.
				if (!signedInEver) throw new Error(`로그인 실패로 실행을 중단했습니다 (${who}) — ${res.note}`);
				onProgress?.({ type: "notice", message: `${why} — ${who} 로그인 실패: ${res.note}` });
				if (credentialRefused)
					onProgress?.({ type: "notice", message: `자격증명이 거부되어 이 배치에서는 재시도하지 않습니다 (${who})` });
				return;
			}
			failedSignIns = 0;
			signedInEver = true;
			// The first authenticated screen is where onboarding/notice popups live — clear them now.
			await page.dismissOverlays().catch(() => {});
			onProgress?.({ type: "notice", message: `${why} — ${who} 계정으로 로그인했습니다` });
		};
		// Public entry screens can carry their own notice popup even before any sign-in.
		if (!input.sample) await page.dismissOverlays().catch(() => {});
		// In-run AI intervention: when a step misses the live DOM, re-read the screen and act on what
		// is actually there (grounded in the live scan) instead of replaying a plan authored blind.
		const repairModel = ai ? modelClient : null;
		const repair = repairModel ? (req: RepairRequest) => repairAction(repairModel, req) : undefined;
		/**
		 * Inter-case recovery. A case that aborted mid-plan leaves the shared page wherever it broke
		 * (modal open, half-navigated, session expired), and every later case would inherit that wreck.
		 * Reset to a known screen; a bounce back to the login form means the session is gone, which
		 * the next case's auth preparation will fix.
		 */
		let recoveries = 0;
		const recoverBetweenCases = async (): Promise<void> => {
			recoveries++;
			await page.dismissOverlays().catch(() => {});
			await page.goto("/").catch(() => {});
			onProgress?.({ type: "notice", message: `이전 케이스 실패 후 화면을 초기화했습니다 (${recoveries}회)` });
			const snap = await page.snapshot({ screenshot: false }).catch(() => null);
			const bouncedToLogin =
				!!snap && extractStructure(snap.html, snap.url).formFields.some((f) => /비밀번호|password/i.test(f));
			if (bouncedToLogin) signedInAs = null;
		};
		/**
		 * The session contract, enforced before each case runs. The decision itself lives in
		 * `authStepFor` so the whole sequence (login case → role switch → logout → restore) is
		 * unit-tested; here we only carry it out.
		 */
		const prepareAuth = async (tc: NormalizedTC, account: Account | undefined): Promise<void> => {
			casesSinceAttempt++;
			const step = authStepFor(
				tc,
				account,
				{ signedInAs, failedSignIns, credentialRefused, casesSinceAttempt },
				{ sample: input.sample },
			);
			if (step.kind === "signOut") {
				await page.resetSession().catch(() => {});
				signedInAs = null;
			} else if (step.kind === "signIn" && hasCreds(account)) {
				if (failedSignIns >= 2)
					onProgress?.({ type: "notice", message: "로그인 연속 실패 후 재시도 창 — 다시 로그인해 봅니다" });
				await ensureSignedInAs(account, tc.title || tc.caseId);
			}
		};
		/**
		 * Plan authoring is a model round trip (~20s) while executing a case is ~1-2s of browser work,
		 * so authoring inline made the run 20× slower than the app it drives. Author *ahead*: keep a
		 * small window of cases in flight so the model works while the browser does, and a case's plan
		 * is usually already waiting when its turn comes. Authoring stays per case (independent inputs,
		 * cache keyed per case), and a failure is isolated — that one case falls back to rule
		 * interpretation instead of killing the batch.
		 */
		const accountFor = (tc: NormalizedTC): Account | undefined =>
			accounts.find((a) => a.role && tc.role && a.role.trim().toLowerCase() === tc.role.trim().toLowerCase()) ??
			defaultAccount;
		const PLAN_PREFETCH = 4;
		/**
		 * How long the case loop waits for a plan before running the case on rules instead.
		 *
		 * Above the model client's own per-request ceiling, so a bounded-but-slow call still gets to
		 * finish and be used; this only catches the case where waiting longer costs more than the plan
		 * is worth to *this* run.
		 */
		const PLAN_BUDGET_MS = 150_000;
		const planning = new Map<string, Promise<AuthoredPlan | undefined>>();
		const authorAhead = (from: number): void => {
			if (!ai || !modelClient || signal?.aborted) return;
			for (let i = from; i < Math.min(from + PLAN_PREFETCH, cases.length); i++) {
				const tc = cases[i];
				if (!tc || planning.has(tc.caseId)) continue;
				const acct = accountFor(tc);
				const authored = getOrAuthorPlan(tc, sheetSt.rule, sheetSt.planCache, modelClient, {
					referenceRepo: input.referenceRepo,
					username: acct?.username,
					password: acct?.password,
				});
				/**
				 * Stop waiting after a budget, but let the authoring finish in the background.
				 *
				 * The case loop awaits this exact promise, so one slow call holds the whole batch: a single
				 * authoring request stalled a 98-case run for nine minutes, 27% of its wall clock, and the
				 * client watching it timed out. The request itself is now bounded, but a *legitimately*
				 * slow call must not hold 97 other cases either — so this case falls back to rule
				 * interpretation while the model keeps working, and the plan it eventually returns still
				 * lands in the cache for the next run rather than being thrown away.
				 */
				// `Promise.race` does not cancel the loser, so the timer fires either way: without this flag
				// every case reported a 150s overrun ~150s after its plan had already arrived in 5s. 87 of 98
				// cases "timed out" in a run where nothing had, which cost two misdiagnoses.
				let authoredFirst = false;
				const budget = new Promise<undefined>((resolve) => {
					const t = setTimeout(() => resolve(undefined), PLAN_BUDGET_MS);
					t.unref();
				}).then(() => {
					if (authoredFirst) return undefined;
					onProgress?.({
						type: "notice",
						message: `플랜 작성이 ${PLAN_BUDGET_MS / 1000}초를 넘겨(${tc.title || tc.caseId}) 이 케이스는 규칙 해석으로 진행합니다 — 작성은 계속되어 다음 실행에 쓰입니다.`,
					});
					return undefined;
				});
				planning.set(
					tc.caseId,
					Promise.race([
						authored.then((r) => {
							authoredFirst = true;
							return r.plan;
						}),
						budget,
					]).catch(() => undefined),
				);
				authored.catch((err) => {
					onProgress?.({
						type: "notice",
						message: `플랜 작성 실패(${tc.title || tc.caseId}) — 규칙 해석으로 대체: ${(err as Error).message.slice(0, 120)}`,
					});
				});
			}
		};
		authorAhead(0);
		/**
		 * Preparation plans, keyed by the precondition text rather than the case.
		 *
		 * The measured sheet has seven cases sharing "계정 관리 페이지 내 신규 계정 생성 버튼 선택된 상태",
		 * so keying on the text authors one plan between them instead of seven identical ones. Cached in
		 * the same per-sheet plan cache, which the rule version and AUTHOR_VERSION already invalidate.
		 */
		const preparationFor = async (tc: NormalizedTC): Promise<PageAction[] | undefined> => {
			const text = tc.precondition?.trim();
			if (!ai || !modelClient || !text) return undefined;
			const key = preparationCacheKey(text, sheetSt.rule.ruleId, sheetSt.rule.ruleVersion);
			const cached = sheetSt.planCache.get(key);
			// Derived on the way out, not only at author time: navigating by route is a rule about what a
			// preparation may be, so tightening it has to reach the sheets already cached — the same
			// reason plans are re-sanitized on read.
			// Row clicks belong here too: "임의 계정 선택된 상태" is a precondition far more often than it is
			// a step, and without this the setup clicked a label that has never existed, left the popup shut,
			// and the case's own steps then failed on fields inside it.
			const prep = (a: PageAction[]) =>
				derivePreparationActions(text, withRowClicks(a, { phrases: sheetSt.rule.phrases }), sheetSt.rule.routes);
			if (cached) return prep(cached.actions);
			try {
				const actions = await authorPreparation(text, modelClient, sheetSt.rule);
				sheetSt.planCache.set(key, { actions, assertions: [] });
				return prep(actions);
			} catch (err) {
				onProgress?.({
					type: "notice",
					message: `사전조건 해석 실패(${tc.title || tc.caseId}) — 준비 없이 실행합니다: ${(err as Error).message.slice(0, 100)}`,
				});
				return undefined;
			}
		};

		for (const [index, tc] of cases.entries()) {
			if (signal?.aborted) break;
			const account = accountFor(tc);
			// Top the window back up before waiting, so the model keeps working during this case.
			authorAhead(index + 1);
			const plan = await planning.get(tc.caseId);
			planning.delete(tc.caseId);
			await prepareAuth(tc, account);
			// Authored after auth so the setup starts from the session the case will actually run under.
			const preparation = await preparationFor(tc);
			if (signal?.aborted) break;
			const tracePath = trace ? tracePathFor(input.projectId ?? "sample", sid, tc.caseId) : undefined;
			const r = await runScenario(tc, {
				page,
				rule: sheetSt.rule,
				cache,
				env: { browser: "chromium", viewport: "1280x800", baseUrl },
				plan,
				preparation,
				baseline: layeredBaseline(st, sid),
				baselineEnv,
				tracePath,
				visionAssert: visionFn,
				// Remembered per sheet so a rerun asks the same question once. Vision is a model opinion
				// on a borderline screen and it wavers — measured, that waver was 5 of the 7 verdict
				// changes between consecutive runs of this very sheet.
				visionCache: sheetSt.visionCache,
				ruleId: sheetSt.rule.ruleId,
				ruleVersion: sheetSt.rule.ruleVersion,
				lenientMatch: !!input.lenientMatch,
				assertRetryMs: 2500,
				// A live SPA paints asynchronously; settle the pre-interaction screen so the
				// "did this action change anything" check is not decided by paint timing.
				settleMs: 250,
				repair,
			});
			// Keep the trace only for cases that land in the review queue; drop pass/fail and any stale file.
			const keptTrace =
				(r.verdict === "needs_review" || r.verdict === "error") && !!r.tracePath && existsSync(r.tracePath);
			if (tracePath && !keptTrace) rmSync(tracePath, { force: true });
			// Cap what a sheet accumulates: a 640-case sweep otherwise leaves gigabytes of zips behind.
			if (keptTrace) pruneTraces(traceDirFor(input.projectId ?? "sample", sid));
			if (r.verdict === "needs_review" || r.verdict === "error") {
				// Heal events read "<kind>: <target> — <detail>"; the most severe one explains the review.
				const heal = summarizeHeal(r.healEvents);
				const healTarget = r.healEvents.length ? heal.target : "";
				// A vision dispute outranks the generic fallbacks: it is the only reason that names a
				// concrete thing the reviewer should look at on the screenshot.
				const reason = r.healEvents.length
					? heal.reason
					: r.verdict === "error"
						? (r.errorInfo ?? "error")
						: r.visionNote
							? "vision disagrees"
							: r.vacuousNote
								? "assertion not discriminating"
								: r.coverage && r.coverage.covered < r.coverage.total
									? "requirements partly checked"
									: r.assertions.length === 0
										? "no assertions authored"
										: "baseline pending approval";
				sheetSt.reviewQueue.set(r.caseId, {
					caseId: r.caseId,
					title: caseById.get(r.caseId)?.title || r.caseId,
					category: caseById.get(r.caseId)?.category ?? null,
					steps: caseById.get(r.caseId)?.steps ?? [],
					expected: caseById.get(r.caseId)?.expected ?? "",
					// The rest of the row as written: the starting state the case assumes, and what a person
					// already recorded against it. A reviewer was being asked to judge a screen while the
					// sheet's own verdict and defect note lived in another window.
					...(caseById.get(r.caseId)?.precondition ? { precondition: caseById.get(r.caseId)?.precondition } : {}),
					...(caseById.get(r.caseId)?.recordedVerdict
						? { recordedVerdict: caseById.get(r.caseId)?.recordedVerdict }
						: {}),
					...(caseById.get(r.caseId)?.note ? { note: caseById.get(r.caseId)?.note } : {}),
					// What the engine actually checked. The panel explained *why* it held the case but never
					// showed the checks the verdict was made of, so "확인이 필요한 이유" was the only evidence
					// and a reviewer could not see which requirement passed and which did not.
					assertions: r.assertions.map((a) => ({
						detail: a.detail,
						passed: a.passed,
						kind: a.assertion.kind,
						value: describeAssertion(a.assertion),
					})),
					verdict: r.verdict,
					reason,
					holdNote:
						r.visionNote ??
						r.vacuousNote ??
						(r.coverage && r.coverage.covered < r.coverage.total
							? `요구사항 ${r.coverage.total}건 중 ${r.coverage.covered}건만 검증했습니다. 검증하지 않은 항목: ${r.coverage.missing
									.map((m) => m.replace(/\s+/g, " ").slice(0, 60))
									.join(" / ")
									.slice(0, 300)}`
							: undefined),
					healTarget,
					url: r.snapshot?.url ?? "",
					text: (r.snapshot?.text ?? "").slice(0, 600),
					screenshot: r.snapshot?.screenshot,
					trace: keptTrace,
					// Only a case that actually ran can be signed off with a golden baseline.
					baselineEligible: r.executedAsWritten !== false,
					ruleVersion: r.ruleVersion,
					env: baselineEnv,
					sheetId: sid,
				});
			}
			counts[r.verdict] += 1;
			const view: CaseView = {
				caseId: r.caseId,
				title: tc.title || r.caseId,
				category: tc.category,
				// The case as the sheet wrote it. The results table renders a verdict against a title, and a
				// reviewer reading "fail" there had no way to see what the case even asked for without
				// opening the sheet in another window.
				steps: tc.steps,
				expected: tc.expected,
				...(tc.precondition ? { precondition: tc.precondition } : {}),
				...(tc.recordedVerdict ? { recordedVerdict: tc.recordedVerdict } : {}),
				...(tc.note ? { note: tc.note } : {}),
				verdict: r.verdict,
				confidence: r.confidence,
				passed: r.assertions.filter((a) => a.passed).length,
				total: r.assertions.length,
				heal: r.healEvents,
				...(r.baselineLifted ? { baselineLifted: true } : {}),
				assertions: r.assertions.map((a) => ({
					detail: a.detail,
					passed: a.passed,
					kind: a.assertion.kind,
					value: describeAssertion(a.assertion),
				})),
			};
			results.push(view);
			onProgress?.({ type: "case", index: results.length - 1, total: cases.length, result: view });
			// A logout case ends the session on purpose — don't let the next case inherit a dead one.
			if (endsSignedOut(tc)) signedInAs = null;
			// A case that aborted (or errored) left the shared page in an untrusted state — reset before the next one.
			if (!input.sample && !signal?.aborted && (r.aborted || r.verdict === "error")) await recoverBetweenCases();
		}
	} finally {
		await page.close().catch(() => {});
		stop();
	}
	return finish();
}

// --- Run registry: keeps a run alive across a client refresh, and enables reconnect + explicit cancel. ---
interface ActiveRun {
	projectId: string;
	sheetId?: string;
	kind: "single" | "all";
	status: "running" | "done" | "error" | "cancelled";
	startedAt: number;
	interpreter?: "ai" | "rule";
	baseUrl?: string;
	total: number;
	results: CaseView[];
	counts: Record<Verdict, number>;
	error?: string;
	controller: AbortController;
}
const activeRuns = new Map<string, ActiveRun>();

function emptyVerdictCounts(): Record<Verdict, number> {
	return { pass: 0, fail: 0, needs_review: 0, error: 0 };
}

/** Serialize an active run for the reconnect API (drops the live AbortController). */
function activeRunView(r: ActiveRun) {
	return {
		projectId: r.projectId,
		sheetId: r.sheetId,
		kind: r.kind,
		status: r.status,
		startedAt: r.startedAt,
		interpreter: r.interpreter,
		baseUrl: r.baseUrl,
		total: r.total,
		done: r.results.length,
		results: r.results,
		counts: r.counts,
		error: r.error,
	};
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
	if (req.method === "GET" && url.pathname.startsWith("/trace-viewer")) {
		return serveTraceViewer(res, url.pathname);
	}
	if (req.method === "GET" && url.pathname === "/api/trace") {
		const projectId = url.searchParams.get("projectId") || "sample";
		const sheetId = url.searchParams.get("sheetId");
		const caseId = url.searchParams.get("caseId");
		if (!sheetId || !caseId) return send(res, 400, JSON.stringify({ error: "sheetId and caseId are required" }));
		const file = tracePathFor(projectId, sheetId, caseId);
		if (!existsSync(file)) return send(res, 404, JSON.stringify({ error: "trace not found" }));
		res.writeHead(200, { "content-type": "application/zip" });
		res.end(readFileSync(file));
		return;
	}
	if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
		return serveStatic(res, url.pathname);
	}
	if (req.method === "GET" && url.pathname === "/api/history") {
		const pid = url.searchParams.get("projectId") || "sample";
		const st = stateFor(pid);
		const project = allProjects().find((p) => p.id === pid);
		const sid = resolveSheetId(project, url.searchParams.get("sheetId") ?? undefined);
		return send(res, 200, JSON.stringify(sheetState(st, sid).history));
	}
	if (req.method === "POST" && url.pathname === "/api/run") {
		const input = JSON.parse((await readBody(req)) || "{}") as RunInput;
		const projectId = input.projectId ?? "sample";
		if (activeRuns.get(projectId)?.status === "running") {
			return send(res, 409, JSON.stringify({ error: "이미 실행 중인 런이 있습니다. 먼저 중지하세요." }));
		}
		res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" });
		const run: ActiveRun = {
			projectId,
			sheetId: input.sheetId,
			kind: "single",
			status: "running",
			startedAt: Date.now(),
			total: 0,
			results: [],
			counts: emptyVerdictCounts(),
			controller: new AbortController(),
		};
		activeRuns.set(projectId, run);
		// The run lives in the registry, decoupled from this request — a client refresh no longer kills it.
		const write = (ev: Record<string, unknown>) => {
			if (res.writableEnded) return;
			try {
				res.write(`${JSON.stringify(ev)}\n`);
			} catch {
				/* client disconnected — the run keeps going in the registry */
			}
		};
		const emit = (ev: Record<string, unknown>) => {
			if (ev.type === "start") {
				run.total = Number(ev.total) || 0;
				run.interpreter = ev.interpreter as "ai" | "rule";
				run.baseUrl = String(ev.baseUrl ?? "");
			} else if (ev.type === "case") {
				const result = ev.result as CaseView;
				run.results.push(result);
				run.counts[result.verdict] = (run.counts[result.verdict] ?? 0) + 1;
			}
			write(ev);
		};
		// A case can take minutes with no event of its own — plan authoring at a high reasoning level
		// stalled one run for nine minutes at case 31. Node's fetch aborts a response body idle for five
		// minutes (`UND_ERR_BODY_TIMEOUT`), so a silent stream loses the client mid-run: the batch keeps
		// going in the registry but whoever asked for it is gone. A heartbeat keeps the stream alive;
		// clients ignore unknown event types.
		const heartbeat = setInterval(() => write({ type: "ping", at: Date.now() }), 20_000);
		heartbeat.unref();
		try {
			const view = await runBatch(input, emit, run.controller.signal);
			run.results = view.results;
			run.counts = view.counts;
			run.status = run.controller.signal.aborted ? "cancelled" : "done";
			write({ type: run.controller.signal.aborted ? "cancelled" : "done", view });
		} catch (err) {
			if (run.controller.signal.aborted) {
				run.status = "cancelled";
				write({ type: "cancelled" });
			} else {
				run.status = "error";
				run.error = (err as Error).message;
				console.error("run failed:", (err as Error).stack ?? err);
				write({ type: "error", error: run.error });
			}
		}
		clearInterval(heartbeat);
		res.end();
		return;
	}
	if (req.method === "POST" && url.pathname === "/api/run/all") {
		const input = JSON.parse((await readBody(req)) || "{}") as RunInput;
		const projectId = input.projectId ?? "sample";
		if (activeRuns.get(projectId)?.status === "running") {
			return send(res, 409, JSON.stringify({ error: "이미 실행 중인 런이 있습니다. 먼저 중지하세요." }));
		}
		res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" });
		const run: ActiveRun = {
			projectId,
			kind: "all",
			status: "running",
			startedAt: Date.now(),
			total: 0,
			results: [],
			counts: emptyVerdictCounts(),
			controller: new AbortController(),
		};
		activeRuns.set(projectId, run);
		const write = (ev: Record<string, unknown>) => {
			if (res.writableEnded) return;
			try {
				res.write(`${JSON.stringify(ev)}\n`);
			} catch {
				/* client disconnected — the run keeps going in the registry */
			}
		};
		const sheets = input.sheets ?? input.sources ?? [];
		// Same reason as the single-sheet stream: a long silent gap loses the client to fetch's idle
		// body timeout while the batch carries on in the registry.
		const heartbeat = setInterval(() => write({ type: "ping", at: Date.now() }), 20_000);
		heartbeat.unref();
		try {
			write({
				type: "all-start",
				totalSheets: sheets.length,
				sheets: sheets.map((s) => ({ sheetId: s.id, name: s.name })),
			});
			for (let i = 0; i < sheets.length; i++) {
				if (run.controller.signal.aborted) break;
				const sheet = sheets[i];
				if (!sheet) continue;
				write({ type: "sheet-start", sheetId: sheet.id, name: sheet.name, index: i, totalSheets: sheets.length });
				try {
					const view = await runBatch(
						{ ...input, sheets: [sheet], sheetId: sheet.id },
						(ev) => write({ ...ev, sheetId: sheet.id }),
						run.controller.signal,
					);
					write({ type: "sheet-done", sheetId: sheet.id, view });
				} catch (err) {
					if (run.controller.signal.aborted) break;
					console.error("run-all sheet failed:", (err as Error).stack ?? err);
					write({ type: "sheet-error", sheetId: sheet.id, error: (err as Error).message });
				}
			}
			run.status = run.controller.signal.aborted ? "cancelled" : "done";
			if (!run.controller.signal.aborted) write({ type: "all-done" });
		} catch (err) {
			run.status = "error";
			run.error = (err as Error).message;
			write({ type: "error", error: run.error });
		}
		clearInterval(heartbeat);
		res.end();
		return;
	}
	if (req.method === "GET" && url.pathname === "/api/run/active") {
		const projectId = url.searchParams.get("projectId") || "sample";
		const run = activeRuns.get(projectId);
		return send(res, 200, JSON.stringify(run && run.status === "running" ? activeRunView(run) : null));
	}
	if (req.method === "POST" && url.pathname === "/api/run/cancel") {
		const { projectId } = JSON.parse((await readBody(req)) || "{}") as { projectId?: string };
		const run = activeRuns.get(projectId || "sample");
		if (run && run.status === "running") run.controller.abort();
		return send(res, 200, JSON.stringify({ ok: true }));
	}
	if (req.method === "GET" && url.pathname === "/api/status") {
		return send(
			res,
			200,
			JSON.stringify(
				statusPayload(url.searchParams.get("projectId") || "sample", url.searchParams.get("sheetId") ?? undefined),
			),
		);
	}
	if (req.method === "POST" && url.pathname === "/api/auth") {
		try {
			const body = JSON.parse((await readBody(req)) || "{}") as AuthInput & { projectId?: string };
			auth = connect(body);
			// Remember the choice so a restart restores *this* model at *this* effort, instead of
			// silently adopting whatever the local Codex config happens to say today.
			writeModelPin({ model: auth.model, reasoning: auth.reasoning });
			return send(res, 200, JSON.stringify(statusPayload(body.projectId || "sample")));
		} catch (err) {
			return send(res, 400, JSON.stringify({ error: (err as Error).message }));
		}
	}
	if (req.method === "POST" && url.pathname === "/api/auth/device/start") {
		try {
			const body = JSON.parse((await readBody(req)) || "{}") as AuthInput;
			const started = await startDeviceLogin(body.model, body.reasoning);
			return send(res, 200, JSON.stringify(started));
		} catch (err) {
			return send(res, 400, JSON.stringify({ error: (err as Error).message }));
		}
	}
	if (req.method === "POST" && url.pathname === "/api/auth/device/poll") {
		try {
			const body = JSON.parse((await readBody(req)) || "{}") as { projectId?: string };
			const result = await pollDeviceLogin();
			if (result === "pending") return send(res, 200, JSON.stringify({ pending: true }));
			auth = result;
			return send(res, 200, JSON.stringify(statusPayload(body.projectId || "sample")));
		} catch (err) {
			return send(res, 400, JSON.stringify({ error: (err as Error).message }));
		}
	}
	if (req.method === "POST" && url.pathname === "/api/refine/reset") {
		const { projectId, sheetId } = JSON.parse((await readBody(req)) || "{}") as {
			projectId?: string;
			sheetId?: string;
		};
		const pid = projectId || "sample";
		const st = stateFor(pid);
		const project = allProjects().find((p) => p.id === pid);
		const sid = resolveSheetId(project, sheetId);
		const ss = sheetState(st, sid);
		ss.refineChat.length = 0;
		ss.rule = structuredClone(st.defaultRule);
		saveState(pid, st);
		return send(res, 200, JSON.stringify(statusPayload(pid, sid)));
	}
	if (req.method === "POST" && url.pathname === "/api/sheet/clear") {
		try {
			const { projectId, sheetId } = JSON.parse((await readBody(req)) || "{}") as {
				projectId?: string;
				sheetId?: string;
			};
			const pid = projectId || "sample";
			const st = stateFor(pid);
			const project = allProjects().find((p) => p.id === pid);
			const sid = resolveSheetId(project, sheetId);
			clearSheetRuns(st, sid);
			rmSync(traceDirFor(pid, sid), { recursive: true, force: true }); // drop leftover trace zips
			saveState(pid, st);
			return send(res, 200, JSON.stringify({ cleared: true }));
		} catch (err) {
			return send(res, 400, JSON.stringify({ error: (err as Error).message }));
		}
	}
	if (req.method === "POST" && url.pathname === "/api/rule/context") {
		try {
			const { appContext, codeContext, projectId, sheetId } = JSON.parse((await readBody(req)) || "{}") as {
				appContext?: string;
				codeContext?: string;
				projectId?: string;
				sheetId?: string;
			};
			const pid = projectId || "sample";
			const st = stateFor(pid);
			const project = allProjects().find((p) => p.id === pid);
			const sid = resolveSheetId(project, sheetId);
			const ss = sheetState(st, sid);
			if (appContext !== undefined) ss.rule = setRuleContext(ss.rule, String(appContext).slice(0, 4000));
			if (codeContext !== undefined) ss.rule = setRuleCodeContext(ss.rule, String(codeContext).slice(0, 8000));
			saveState(pid, st);
			return send(res, 200, JSON.stringify(statusPayload(pid, sid)));
		} catch (err) {
			return send(res, 400, JSON.stringify({ error: (err as Error).message }));
		}
	}
	if (req.method === "POST" && url.pathname === "/api/refine") {
		if (!modelClient) return send(res, 400, JSON.stringify({ error: "Connect a model first." }));
		try {
			const { instruction, projectId, sheetId } = JSON.parse((await readBody(req)) || "{}") as {
				instruction?: string;
				projectId?: string;
				sheetId?: string;
			};
			if (!instruction?.trim()) return send(res, 400, JSON.stringify({ error: "Instruction is required." }));
			const pid = projectId || "sample";
			const st = stateFor(pid);
			const project = allProjects().find((p) => p.id === pid);
			const sid = resolveSheetId(project, sheetId);
			const ss = sheetState(st, sid);
			const prev = ss.rule;
			const result = await refineRule(ss.rule, instruction, modelClient, [...ss.refineChat]);
			ss.rule = result.rule;
			ss.refineChat.push({ role: "user", content: instruction }, { role: "assistant", content: result.message });
			if (ss.refineChat.length > 20) ss.refineChat.splice(0, ss.refineChat.length - 20);
			saveState(pid, st);
			return send(
				res,
				200,
				JSON.stringify({
					message: result.message,
					changed: result.changed,
					ruleVersion: ss.rule.ruleVersion,
					intents: ss.rule.intents,
					mapping: ss.rule.mapping,
					diff: intentDiff(prev, ss.rule),
					warnings: ruleLint(ss.rule),
					chat: ss.refineChat,
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
			const { sheetUrl, csvText, projectId, sheetId } = JSON.parse((await readBody(req)) || "{}") as {
				sheetUrl?: string;
				csvText?: string;
				projectId?: string;
				sheetId?: string;
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
			const pid = projectId || "sample";
			const project = userProjects.find((p) => p.id === pid);
			const sheet = project?.sheets.find((s) => s.id === sheetId);
			if (!project || !sheet)
				return send(res, 400, JSON.stringify({ error: "analyze requires a saved project sheet" }));
			const st = stateFor(pid);
			const sid = resolveSheetId(project, sheetId);
			const ss = sheetState(st, sid);
			const result = await refineRule(ss.rule, instruction, modelClient, [...ss.refineChat]);
			// Don't mutate the project-shared rule here — a sheet's column mapping is a per-sheet
			// override layered on top of it, so only the delta vs the current rule mapping is kept.
			const proposed = result.rule.mapping;
			const delta: Record<string, string> = {};
			for (const [k, v] of Object.entries(proposed)) {
				if (v && v !== (ss.rule.mapping as Record<string, string>)[k]) delta[k] = v;
			}
			if (Object.keys(delta).length) sheet.mapping = delta as InterpretationRule["mapping"];
			else delete sheet.mapping;
			persistProjects();
			ss.refineChat.push(
				{ role: "user", content: `시트 해석 요청 · 헤더: ${table.headers.join(", ")}` },
				{ role: "assistant", content: result.message },
			);
			if (ss.refineChat.length > 20) ss.refineChat.splice(0, ss.refineChat.length - 20);
			saveState(pid, st);
			return send(
				res,
				200,
				JSON.stringify({
					headers: table.headers,
					sample,
					mapping: delta,
					sheetId,
					ruleVersion: ss.rule.ruleVersion,
					message: result.message,
					warnings: ruleLint(ss.rule),
					chat: ss.refineChat,
				}),
			);
		} catch (err) {
			console.error("analyze failed:", (err as Error).stack ?? err);
			return send(res, 400, JSON.stringify({ error: (err as Error).message }));
		}
	}
	if (req.method === "POST" && url.pathname === "/api/app/analyze") {
		if (!modelClient) return send(res, 400, JSON.stringify({ error: "Connect a model first." }));
		try {
			const body = JSON.parse((await readBody(req)) || "{}") as {
				projectId?: string;
				sheetId?: string;
				deep?: boolean;
				loginPath?: string;
				accountId?: string;
			};
			const pid = body.projectId || "sample";
			const project = userProjects.find((p) => p.id === pid);
			const sheet = project?.sheets.find((s) => s.id === body.sheetId) ?? project?.sheets[0];
			if (!project || !sheet)
				return send(res, 400, JSON.stringify({ error: "앱 분석에는 저장된 프로젝트 시트가 필요합니다." }));
			const baseUrl = (sheet.baseUrl || project.baseUrl || "").trim();
			if (!baseUrl)
				return send(res, 400, JSON.stringify({ error: "프로젝트나 시트에 baseUrl(주소)을 먼저 설정하세요." }));
			const account = project.accounts.find((a) => a.id === (body.accountId || sheet.accountId)) ?? project.accounts[0];
			const page = await BrowserPage.create({ baseUrl, timeoutMs: 8000, browser: await sharedBrowser() });
			let result: ReconResult;
			try {
				result = await reconApp(page, modelClient, {
					loginPath: body.loginPath?.trim() || undefined,
					deep: !!body.deep,
					account: account ? { username: account.username, password: account.password } : undefined,
				});
			} finally {
				await page.close();
			}
			// Persist what recon saw. The prose brief grounds the plan model; the route table is read by
			// code (a url assertion for a navigation expectation), which a paragraph cannot support.
			const routes = routeTable(result.pages);
			if (result.context?.trim() || routes.length > 0) {
				const st = stateFor(pid);
				const sid = resolveSheetId(project, sheet.id);
				const ss = sheetState(st, sid);
				if (result.context?.trim()) ss.rule = setRuleContext(ss.rule, result.context.slice(0, 4000));
				ss.rule = setRuleRoutes(ss.rule, routes);
				saveState(pid, st);
			}
			return send(
				res,
				200,
				JSON.stringify({
					context: result.context,
					loggedIn: result.loggedIn,
					notes: result.notes,
					pages: result.pages.map((p) => ({
						url: p.url,
						title: p.title,
						navLabels: p.links.map((l) => l.label).slice(0, 25),
						formFields: p.formFields,
						buttons: p.buttons,
						tableHeaders: p.tableHeaders,
					})),
				}),
			);
		} catch (err) {
			console.error("app analyze failed:", (err as Error).stack ?? err);
			return send(res, 400, JSON.stringify({ error: (err as Error).message }));
		}
	}
	if (req.method === "POST" && url.pathname === "/api/repo/analyze") {
		if (!modelClient) return send(res, 400, JSON.stringify({ error: "Connect a model first." }));
		try {
			const body = JSON.parse((await readBody(req)) || "{}") as {
				projectId?: string;
				sheetId?: string;
				query?: string;
				token?: string;
				refresh?: boolean;
			};
			const pid = body.projectId || "sample";
			const project = userProjects.find((p) => p.id === pid);
			if (!project) return send(res, 400, JSON.stringify({ error: "레포 분석에는 저장된 프로젝트가 필요합니다." }));
			const source = (project.referenceRepo || "").trim();
			if (!source)
				return send(res, 400, JSON.stringify({ error: "프로젝트에 referenceRepo(레포 경로/URL)를 먼저 설정하세요." }));
			const cacheDir = join(homedir(), ".test-osterone", "repo-cache", pid);
			const notes: string[] = [];
			const { dir, mode } = acquireRepo(source, cacheDir, { token: body.token, refresh: body.refresh });
			notes.push(
				mode === "local"
					? "로컬 경로 사용"
					: mode === "cached"
						? "캐시된 클론 재사용"
						: body.refresh
							? "새로 클론(refresh)"
							: "shallow clone 완료",
			);
			const query = body.query?.trim() || project.name;
			const result: RepoReconResult = await reconRepo(dir, modelClient, { query, repoMode: mode });
			return send(
				res,
				200,
				JSON.stringify({
					context: result.context,
					codegraph: result.codegraph,
					notes: [...notes, ...result.notes],
					digest: {
						name: result.digest.name,
						scripts: result.digest.scripts,
						routes: result.digest.routes,
						components: result.digest.components,
						fileCount: result.digest.files.length,
					},
				}),
			);
		} catch (err) {
			console.error("repo analyze failed:", (err as Error).stack ?? err);
			return send(res, 400, JSON.stringify({ error: (err as Error).message }));
		}
	}
	if (req.method === "POST" && url.pathname === "/api/tc/preview") {
		try {
			const cfg = JSON.parse((await readBody(req)) || "{}") as RunInput;
			const pid = cfg.projectId || "sample";
			const st = stateFor(pid);
			const project = allProjects().find((p) => p.id === pid);
			let headers: string[] = [];
			let all: NormalizedTC[];
			let unique: NormalizedTC[];
			let duplicates: DedupeResult["duplicates"];
			let effMapping: InterpretationRule["mapping"] = sheetState(st, resolveSheetId(project)).rule.mapping;
			if (cfg.sample) {
				const text = readFileSync(cfg.aiInterpret ? bundledCasesNl : bundledCases, "utf8");
				headers = csvToRawTable(text).headers;
				({ all, unique, duplicates } = ingestCsv(text, effMapping));
			} else {
				const sources = hydrateSheets(cfg.projectId ?? "sample", cfg.sheets ?? cfg.sources ?? []);
				if (sources.length === 0) return send(res, 400, JSON.stringify({ error: "TC 소스를 추가하세요." }));
				const sid = resolveSheetId(project, cfg.sheetId);
				const sheet = sources.find((s) => s.id === sid) ?? sources[0];
				effMapping = { ...sheetState(st, sid).rule.mapping, ...(sheet?.mapping ?? {}) };
				const first = sources[0];
				const firstText = first
					? first.kind === "sheet"
						? await ingestGoogleSheetText(first.sheetUrl)
						: first.csvText
					: "";
				headers = csvToRawTable(firstText).headers;
				({ all, unique, duplicates } = await ingestSources(sources, effMapping));
			}
			return send(
				res,
				200,
				JSON.stringify({
					headers,
					mapping: { ...mapColumns(headers), ...effMapping },
					counts: { total: all.length, unique: unique.length, duplicates: duplicates.length },
					unique: unique.map((c) => ({
						caseId: c.caseId,
						title: c.title,
						steps: c.steps,
						expected: c.expected,
						priority: c.priority,
						category: c.category,
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
				const map = mapColumns(csvToRawTable(csv).headers);
				return { name, csv, rows, isTc: Boolean(map.step && map.expected) };
			}).filter((s) => s.rows > 1);
			return send(res, 200, JSON.stringify({ sheets }));
		} catch (err) {
			return send(res, 400, JSON.stringify({ error: (err as Error).message }));
		}
	}
	if (req.method === "GET" && url.pathname === "/api/review/queue") {
		const pid = url.searchParams.get("projectId") || "sample";
		const st = stateFor(pid);
		const reconcile = (items: ReviewItem[]): ReviewItem[] =>
			items.filter((it) => {
				if (layeredBaseline(st, it.sheetId).get(it.caseId, it.ruleVersion, it.env)?.approved === true) return false;
				const rej = sheetState(st, it.sheetId).rejections.get(it.caseId);
				if (rej && rej.ruleVersion === it.ruleVersion && rej.env === it.env) return false;
				return true;
			});
		if (url.searchParams.get("all")) {
			const all = [...st.sheets.values()].flatMap((s) => [...s.reviewQueue.values()]);
			return send(res, 200, JSON.stringify(reconcile(all)));
		}
		const project = allProjects().find((p) => p.id === pid);
		const sid = resolveSheetId(project, url.searchParams.get("sheetId") ?? undefined);
		return send(res, 200, JSON.stringify(reconcile([...sheetState(st, sid).reviewQueue.values()])));
	}
	if (req.method === "POST" && url.pathname === "/api/review/approve") {
		try {
			const { caseId, projectId, sheetId } = JSON.parse((await readBody(req)) || "{}") as {
				caseId?: string;
				projectId?: string;
				sheetId?: string;
			};
			const pid = projectId || "sample";
			const st = stateFor(pid);
			let item: ReviewItem | undefined;
			let sid = sheetId;
			if (sid) {
				item = caseId ? sheetState(st, sid).reviewQueue.get(caseId) : undefined;
			} else if (caseId) {
				for (const [k, s] of st.sheets) {
					const found = s.reviewQueue.get(caseId);
					if (found) {
						item = found;
						sid = k;
						break;
					}
				}
			}
			if (!item || !sid) return send(res, 404, JSON.stringify({ error: "unknown case in review queue" }));
			if (item.baselineEligible === false) {
				// A case that never ran has no proposed baseline, and signing off the screen it happened
				// to stop on would pass it without exercising anything. Say why instead of throwing.
				return send(
					res,
					400,
					JSON.stringify({
						error:
							"작성된 대로 실행되지 않은 케이스입니다(스텝 미해석·동작 실패·중단). 기준 화면으로 승인할 수 없습니다 — 규칙을 고치거나 모델을 연결해 다시 실행하세요.",
					}),
				);
			}
			// The run's gate() already proposed a full-text pending baseline; approving flips it.
			sheetState(st, sid).baseline.approve(item.caseId, item.ruleVersion, item.env);
			sheetState(st, sid).reviewQueue.delete(item.caseId);
			saveState(pid, st);
			return send(
				res,
				200,
				JSON.stringify({
					approved: true,
					caseId: item.caseId,
					queue: [...sheetState(st, sid).reviewQueue.values()],
				}),
			);
		} catch (err) {
			return send(res, 400, JSON.stringify({ error: (err as Error).message }));
		}
	}
	if (req.method === "POST" && url.pathname === "/api/review/reject") {
		try {
			const { caseId, projectId, sheetId } = JSON.parse((await readBody(req)) || "{}") as {
				caseId?: string;
				projectId?: string;
				sheetId?: string;
			};
			const pid = projectId || "sample";
			const st = stateFor(pid);
			let item: ReviewItem | undefined;
			let sid = sheetId;
			if (sid) {
				item = caseId ? sheetState(st, sid).reviewQueue.get(caseId) : undefined;
			} else if (caseId) {
				for (const [k, s] of st.sheets) {
					const found = s.reviewQueue.get(caseId);
					if (found) {
						item = found;
						sid = k;
						break;
					}
				}
			}
			if (!item || !sid) return send(res, 404, JSON.stringify({ error: "unknown case in review queue" }));
			// Human verdict: this held case is a real fail. Recorded per (caseId, ruleVersion, env) so it
			// doesn't re-surface until the case content or rule changes (symmetric with baseline approval).
			sheetState(st, sid).rejections.set(item.caseId, {
				caseId: item.caseId,
				ruleVersion: item.ruleVersion,
				env: item.env,
				at: Date.now(),
			});
			sheetState(st, sid).reviewQueue.delete(item.caseId);
			saveState(pid, st);
			return send(
				res,
				200,
				JSON.stringify({
					rejected: true,
					caseId: item.caseId,
					queue: [...sheetState(st, sid).reviewQueue.values()],
				}),
			);
		} catch (err) {
			return send(res, 400, JSON.stringify({ error: (err as Error).message }));
		}
	}
	/**
	 * `/api/review/approve-all` is gone on purpose.
	 *
	 * Approving a golden baseline is a judgement about one specific screen, and every reason a case
	 * reaches this queue now means "the engine could not confirm this — look at it": the text was not
	 * there, the check does not discriminate, only some of the written outcomes were tested, an AI
	 * repaired an action. A button that blesses all of them at once is a false-pass factory, and it was
	 * measured as one on the 샘플관리 sheet: one click took a run that correctly held 15 of 20 cases
	 * (false-pass 1) to 12 passes and false-pass 7 — six screens a human had already filed as defects,
	 * green from then on, because approvals outlive "Clear runs".
	 *
	 * There is no honest bulk version: "I checked all 15 screenshots" is exactly the claim nobody
	 * makes truthfully. Approve per case (`/api/review/approve`) or mark it failed
	 * (`/api/review/reject`).
	 */

	if (req.method === "GET" && url.pathname === "/api/sheet/content") {
		const projectId = url.searchParams.get("projectId");
		const sheetId = url.searchParams.get("sheetId");
		if (!projectId || !sheetId) return send(res, 400, JSON.stringify({ error: "projectId and sheetId are required" }));
		return send(res, 200, JSON.stringify({ csvText: readSheetContent(projectId, sheetId) }));
	}
	if (req.method === "GET" && url.pathname === "/api/projects") {
		return send(res, 200, JSON.stringify(allProjects()));
	}
	if (req.method === "POST" && url.pathname === "/api/projects") {
		try {
			const p = sanitizeProject(JSON.parse((await readBody(req)) || "{}"));
			if (p.id === "sample") return send(res, 400, JSON.stringify({ error: "cannot modify the sample project" }));
			const prev = userProjects.find((x) => x.id === p.id);
			const keptIds = new Set(p.sheets.map((s) => s.id));
			for (const sh of p.sheets) {
				if (sh.kind === "csv" && sh.csvText) {
					writeSheetContent(p.id, sh.id, sh.csvText);
					sh.csvText = "";
				}
			}
			if (prev) {
				for (const oldSheet of prev.sheets) {
					if (oldSheet.kind === "csv" && !keptIds.has(oldSheet.id)) deleteSheetContent(p.id, oldSheet.id);
				}
			}
			const idx = userProjects.findIndex((x) => x.id === p.id);
			if (idx >= 0) userProjects[idx] = p;
			else userProjects.push(p);
			persistProjects();
			const st = stateFor(p.id);
			const ids = new Set(p.sheets.map((s) => s.id));
			for (const k of [...st.sheets.keys()]) if (!ids.has(k)) st.sheets.delete(k);
			saveState(p.id, st);
			return send(res, 200, JSON.stringify({ saved: p, projects: allProjects() }));
		} catch (err) {
			return send(res, 400, JSON.stringify({ error: (err as Error).message }));
		}
	}
	if (req.method === "POST" && url.pathname === "/api/projects/delete") {
		const { id } = JSON.parse((await readBody(req)) || "{}") as { id?: string };
		userProjects = userProjects.filter((x) => x.id !== id);
		persistProjects();
		if (id && id !== "sample") {
			projectStates.delete(id);
			deleteProjectState(id);
			deleteProjectSheets(id);
			rmSync(traceDirFor(id), { recursive: true, force: true }); // drop the project's trace zips
		}
		return send(res, 200, JSON.stringify({ projects: allProjects() }));
	}
	return send(res, 404, JSON.stringify({ error: "not found" }));
}

async function main(): Promise<number> {
	// Registered before anything can spawn a browser: `--selftest` runs a batch (and therefore
	// Chromium) too, and it used to exit with no terminal restoration at all.
	process.on("exit", restoreProcessTerminal);
	if (process.argv.includes("--selftest")) {
		const view = await runBatch({ sample: true });
		console.log("studio selftest — counts:", JSON.stringify(view.counts));
		for (const r of view.results) console.log(`  ${r.verdict.padEnd(13)} ${r.passed}/${r.total}  ${r.title}`);
		const ok = view.counts.pass === 2 && view.counts.fail === 1 && view.counts.needs_review === 1;
		console.log(ok ? "SELFTEST OK" : "SELFTEST MISMATCH");
		await shutdownBrowser();
		return ok ? 0 : 1;
	}
	let shuttingDown = false;
	const shutdown = (): void => {
		// A second Ctrl+C forces an immediate exit instead of waiting on cleanup.
		if (shuttingDown) {
			restoreProcessTerminal();
			process.exit(0);
		}
		shuttingDown = true;
		// Restore now so a slow or stuck browser close never leaves the shell unusable in the
		// meantime; the `exit` listener runs it again afterwards, because closing Chromium can touch
		// the console on its way out.
		restoreProcessTerminal();
		// Bounded cleanup: never hang the terminal on a slow/stuck browser close.
		const timer = setTimeout(() => process.exit(0), 2000);
		timer.unref();
		// Let Playwright delete its scratch dirs instead of orphaning gigabytes in temp.
		void shutdownBrowser().finally(() => {
			clearTimeout(timer);
			process.exit(0);
		});
	};
	// Exactly one handler per signal. There used to be two competing registrations for SIGINT/SIGTERM
	// — the second closed the browser and exited without restoring anything, racing the first to
	// `process.exit` and closing the browser twice. SIGBREAK (Windows Ctrl+Break) and SIGHUP (console
	// window closed) are included because Node's default for those is to die without running any
	// listener, leaving the console exactly as the child process left it.
	for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const) process.on(sig, shutdown);
	// Auto-restore a Codex model connection on startup so a server restart never silently drops to rule mode.
	if (!modelClient && readCodexLogin()) {
		try {
			// The pin, not the Codex config: the authoring model must not change underneath cached plans.
			const pin = readModelPin();
			auth = connect({ mode: "codex", ...pin });
			console.log(
				`model: restored Codex connection (${auth.model}${auth.reasoning ? ` · ${auth.reasoning}` : ""})` +
					`${pin.model || pin.reasoning ? " [pinned]" : " [from codex config]"}`,
			);
		} catch (err) {
			console.warn("model: could not auto-restore Codex connection:", (err as Error).message);
		}
	}
	// A killed run's trace scratch survives in the OS temp dir; clear the dead ones before starting.
	sweepPlaywrightTemp();
	const port = Number(process.env.PORT ?? 8686);
	const server = createServer((req, res) => {
		handle(req, res).catch((err) => send(res, 500, JSON.stringify({ error: String(err) })));
	});
	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") {
			console.error(
				`\n포트 ${port}이(가) 이미 사용 중입니다. 다른 Studio가 이미 실행 중이거나, 다른 포트로 띄우려면:  PORT=${port + 1} bun run studio\n`,
			);
			process.exit(1);
		}
		throw err;
	});
	server.listen(port, () => {
		console.log(`test-osterone Studio → http://localhost:${port}`);
		maybePromptStar({ requireTty: false });
	});
	return 0;
}

main()
	.then((code) => {
		if (code !== 0 || process.argv.includes("--selftest")) process.exit(code);
	})
	.catch((err: unknown) => {
		// A startup failure (browser not installed, unreadable state, a throwing selftest) used to
		// escape as an unhandled rejection: Node dumps a stack over whatever the terminal was
		// rendering and tears the process down without our shutdown, so the console keeps whatever
		// input mode a child left behind. Exit through the same restore + close path as Ctrl+C, and
		// print the actionable message instead of the stack.
		restoreProcessTerminal();
		console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
		void shutdownBrowser().finally(() => process.exit(1));
	});
