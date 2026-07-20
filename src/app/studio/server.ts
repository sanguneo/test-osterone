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

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserPage } from "../../execute/browser-page.ts";
import { runScenario, type Verdict } from "../../execute/runner.ts";
import { ingestCsv, ingestGoogleSheet } from "../../intake/ingest.ts";
import type { NormalizedTC } from "../../intake/schema.ts";
import { MemoryAssertionCache } from "../../interpret/assertion.ts";
import { establishRuleFromHeaders, type InterpretationRule, refineRule } from "../../interpret/rule.ts";
import { readCodexLogin, readCodexModel } from "../../model/codex-auth.ts";
import { ApiKeyModelClient, type ModelClient } from "../../model/model-client.ts";
import { getCodexAccountId, OAuthProxyModelClient } from "../../model/oauth-proxy.ts";
import { startFixture } from "../../testing/fixture-app.ts";

const here = dirname(fileURLToPath(import.meta.url));
const bundledCases = join(here, "../../testing/sample-cases.csv");

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
	counts: Record<Verdict, number>;
	results: CaseView[];
}

export interface RunInput {
	source: "sample" | "sheet";
	sheetUrl?: string;
	baseUrl?: string;
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

function statusPayload(): Record<string, unknown> {
	return { connected: !!modelClient, auth, ruleVersion: rule.ruleVersion, intents: rule.intents };
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
		const { unique } = await ingestGoogleSheet(input.sheetUrl);
		if (unique.length === 0) throw new Error("No test cases found in the sheet (check sharing = anyone with link).");
		return { cases: unique, baseUrl, stop: () => {} };
	}
	const fixture = await startFixture();
	return { cases: ingestCsv(readFileSync(bundledCases, "utf8")).unique, baseUrl: fixture.url, stop: fixture.stop };
}

/** Ingest → rule → run each case against a real headless browser. Pure engine reuse. */
export async function runBatch(input: RunInput): Promise<RunView> {
	const { cases, baseUrl, stop } = await loadCases(input);
	const cache = new MemoryAssertionCache();
	const page = await BrowserPage.create({ baseUrl, headless: true, timeoutMs: 4000 });
	const counts: Record<Verdict, number> = { pass: 0, fail: 0, needs_review: 0, error: 0 };
	const results: CaseView[] = [];
	try {
		for (const tc of cases) {
			const r = await runScenario(tc, {
				page,
				rule,
				cache,
				env: { browser: "chromium", viewport: "1280x800", baseUrl },
			});
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
	const view: RunView = { at: Date.now(), source: input.source, baseUrl, counts, results };
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
	if (req.method === "POST" && url.pathname === "/api/refine") {
		if (!modelClient) return send(res, 400, JSON.stringify({ error: "Connect a model first." }));
		try {
			const { instruction } = JSON.parse((await readBody(req)) || "{}") as { instruction?: string };
			if (!instruction?.trim()) return send(res, 400, JSON.stringify({ error: "Instruction is required." }));
			const result = await refineRule(rule, instruction, modelClient);
			rule = result.rule;
			return send(
				res,
				200,
				JSON.stringify({
					message: result.message,
					changed: result.changed,
					ruleVersion: rule.ruleVersion,
					intents: rule.intents,
				}),
			);
		} catch (err) {
			console.error("refine failed:", (err as Error).stack ?? err);
			return send(res, 400, JSON.stringify({ error: (err as Error).message }));
		}
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
  header { padding:22px 28px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:14px; }
  header h1 { font-size:18px; margin:0; letter-spacing:.2px; } header .tag { color:var(--dim); font-size:13px; }
  main { max-width:960px; margin:0 auto; padding:24px 20px 60px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin-bottom:20px; }
  label { display:block; font-size:13px; color:var(--dim); margin:12px 0 6px; }
  input[type=text] { width:100%; padding:10px 12px; background:#12151a; border:1px solid var(--line);
      border-radius:8px; color:var(--ink); font-size:14px; }
  textarea { width:100%; padding:10px 12px; background:#12151a; border:1px solid var(--line);
      border-radius:8px; color:var(--ink); font-size:14px; font-family:inherit; resize:vertical; }
  .row { display:flex; gap:18px; flex-wrap:wrap; } .row > div { flex:1 1 260px; }
  .modes { display:flex; gap:10px; margin-bottom:4px; }
  .modes button { flex:1; padding:10px; border:1px solid var(--line); background:#12151a; color:var(--dim);
      border-radius:8px; cursor:pointer; font-size:14px; } .modes button.on { border-color:var(--lime); color:var(--ink); }
  .run { margin-top:16px; padding:12px 20px; background:var(--lime); color:#10130a; border:0; border-radius:8px;
      font-weight:700; font-size:15px; cursor:pointer; } .run:disabled { opacity:.5; cursor:default; }
  .summary { display:flex; gap:10px; flex-wrap:wrap; margin:2px 0 14px; }
  .chip { padding:6px 12px; border-radius:999px; font-size:13px; border:1px solid var(--line); }
  .chip b { font-variant-numeric:tabular-nums; }
  table { width:100%; border-collapse:collapse; } th,td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.4px; }
  .badge { display:inline-block; padding:2px 9px; border-radius:6px; font-size:12px; font-weight:700; }
  .v-pass{ background:rgba(158,230,0,.16); color:var(--pass);} .v-fail{ background:rgba(255,90,82,.16); color:var(--fail);}
  .v-needs_review{ background:rgba(255,176,32,.16); color:var(--review);} .v-error{ background:rgba(122,135,148,.2); color:var(--error);}
  .detail { color:var(--dim); font-size:12.5px; margin-top:3px; } .detail .x{ color:var(--fail);} .detail .o{ color:var(--pass);}
  .heal { color:var(--review); font-size:12px; } .muted{ color:var(--dim); } .err{ color:var(--fail); }
  code { background:#12151a; padding:1px 6px; border-radius:5px; }
</style></head>
<body>
<header><h1>test-osterone <span style="color:var(--lime)">Studio</span></h1>
  <span class="tag">AI가 쓰고, 결정적 엔진이 판정합니다 — 터미널 없이</span></header>
<main>
  <div class="card" id="model-card">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
      <b>모델 연결 <span class="muted" style="font-weight:400">· AI 규칙 다듬기용 (선택)</span></b>
      <span id="auth-badge" class="chip muted">미연결</span>
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
    <div id="refine-box" style="display:none;margin-top:18px;border-top:1px solid var(--line);padding-top:16px">
      <label>AI로 규칙 다듬기 <span class="muted">예: "click은 '누르기'로도 인식해"</span></label>
      <textarea id="instruction" rows="2" placeholder="자연어로 규칙 지시…"></textarea>
      <button id="refine" class="run" type="button" style="margin-top:10px">다듬기</button>
      <span id="refine-status" class="muted" style="margin-left:12px"></span>
      <div id="intents" class="detail" style="margin-top:10px"></div>
    </div>
  </div>
  <div class="card">
    <div class="modes">
      <button id="m-sample" class="on" type="button">샘플로 실행 (번들 데모)</button>
      <button id="m-sheet" type="button">구글 시트로 실행</button>
    </div>
    <div id="sheet-fields" style="display:none">
      <div class="row">
        <div><label>구글 시트 URL <span class="muted">(공유: 링크 있는 모든 사용자 · 보기)</span></label>
          <input id="sheetUrl" type="text" placeholder="https://docs.google.com/spreadsheets/d/…" /></div>
        <div><label>테스트 대상 사이트 URL</label>
          <input id="baseUrl" type="text" placeholder="https://your.app" /></div>
      </div>
    </div>
    <button id="run" class="run" type="button">실행</button>
    <span id="status" class="muted" style="margin-left:12px"></span>
  </div>
  <div id="out"></div>
</main>
<script>
  var mode = "sample";
  var $ = function (id) { return document.getElementById(id); };
  $("m-sample").onclick = function(){ mode="sample"; $("m-sample").classList.add("on"); $("m-sheet").classList.remove("on"); $("sheet-fields").style.display="none"; };
  $("m-sheet").onclick = function(){ mode="sheet"; $("m-sheet").classList.add("on"); $("m-sample").classList.remove("on"); $("sheet-fields").style.display="block"; };

  function badge(v){ return '<span class="badge v-'+v+'">'+v+'</span>'; }
  function esc(s){ var d=document.createElement("div"); d.textContent=s==null?"":String(s); return d.innerHTML; }

  function render(view){
    var c = view.counts, out = "";
    out += '<div class="card">';
    out += '<div class="summary">';
    out += '<span class="chip">대상 <b>'+esc(view.baseUrl)+'</b></span>';
    out += '<span class="chip" style="color:var(--pass)">pass <b>'+(c.pass||0)+'</b></span>';
    out += '<span class="chip" style="color:var(--fail)">fail <b>'+(c.fail||0)+'</b></span>';
    out += '<span class="chip" style="color:var(--review)">needs_review <b>'+(c.needs_review||0)+'</b></span>';
    out += '<span class="chip" style="color:var(--error)">error <b>'+(c.error||0)+'</b></span>';
    out += '</div>';
    out += '<table><thead><tr><th>케이스</th><th>판정</th><th>신뢰도</th><th>assert</th><th>상세</th></tr></thead><tbody>';
    view.results.forEach(function(r){
      var det = r.assertions.map(function(a){ return '<div class="detail">'+(a.passed?'<span class="o">✓</span>':'<span class="x">✗</span>')+' '+esc(a.detail)+'</div>'; }).join("");
      if (r.heal && r.heal.length) det += '<div class="heal">⚠ self-heal: '+esc(r.heal.join("; "))+'</div>';
      out += '<tr><td>'+esc(r.title)+'</td><td>'+badge(r.verdict)+'</td><td>'+r.confidence.toFixed(2)+'</td><td>'+r.passed+'/'+r.total+'</td><td>'+(det||'<span class="muted">—</span>')+'</td></tr>';
    });
    out += '</tbody></table></div>';
    $("out").innerHTML = out;
  }

  $("run").onclick = async function(){
    var body = { source: mode, sheetUrl: $("sheetUrl") ? $("sheetUrl").value.trim() : "", baseUrl: $("baseUrl") ? $("baseUrl").value.trim() : "" };
    $("run").disabled = true; $("status").textContent = "실제 브라우저로 실행 중…"; $("status").className="muted";
    try {
      var res = await fetch("/api/run", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(body) });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || "실행 실패");
      $("status").textContent = "완료";
      render(data);
    } catch (e) {
      $("status").textContent = ""; $("out").innerHTML = '<div class="card err">오류: '+esc(e.message)+'</div>';
    } finally { $("run").disabled = false; }
  };

  var authMode = "codex";
  function setAuthMode(m){ authMode=m;
    ["codex","token","key"].forEach(function(x){ $("a-"+x).classList.toggle("on", x===m); });
    $("a-token-f").style.display = m==="token"?"block":"none";
    $("a-key-f").style.display = m==="key"?"block":"none";
  }
  $("a-codex").onclick=function(){setAuthMode("codex");};
  $("a-token").onclick=function(){setAuthMode("token");};
  $("a-key").onclick=function(){setAuthMode("key");};

  function renderIntents(ruleVersion, intents){
    $("intents").innerHTML = "규칙 v"+ruleVersion+" · " + Object.keys(intents||{}).map(function(k){ return "<code>"+esc(k)+"</code> "+esc((intents[k]||[]).join(", ")); }).join("&nbsp;&nbsp;");
  }
  function renderStatus(s){
    if (s.connected && s.auth){
      $("auth-badge").className="chip"; $("auth-badge").style.color="var(--lime)";
      $("auth-badge").textContent="연결됨 · "+s.auth.mode+(s.auth.accountId?(" · "+s.auth.accountId):"")+" · "+s.auth.model;
      $("refine-box").style.display="block";
    } else {
      $("auth-badge").className="chip muted"; $("auth-badge").style.color=""; $("auth-badge").textContent="미연결";
      $("refine-box").style.display="none";
    }
    if (s.intents) renderIntents(s.ruleVersion, s.intents);
  }

  $("connect").onclick=async function(){
    var body={ mode: authMode==="key"?"apikey":(authMode==="token"?"token":"codex"),
      token: $("token")?$("token").value.trim():"", apiKey: $("apiKey")?$("apiKey").value.trim():"" };
    $("connect").disabled=true; $("auth-status").className="muted"; $("auth-status").textContent="연결 중…";
    try {
      var res=await fetch("/api/auth",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
      var data=await res.json(); if(!res.ok) throw new Error(data.error||"연결 실패");
      $("auth-status").textContent=""; renderStatus(data);
    } catch(e){ $("auth-status").className="err"; $("auth-status").textContent=e.message; }
    finally { $("connect").disabled=false; }
  };

  $("refine").onclick=async function(){
    var ins=$("instruction").value.trim();
    if(!ins){ $("refine-status").className="err"; $("refine-status").textContent="지시를 입력하세요."; return; }
    $("refine").disabled=true; $("refine-status").className="muted"; $("refine-status").textContent="AI가 규칙을 다듬는 중…";
    try {
      var res=await fetch("/api/refine",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({instruction:ins})});
      var data=await res.json(); if(!res.ok) throw new Error(data.error||"실패");
      $("refine-status").className="muted"; $("refine-status").textContent=(data.changed?"규칙 갱신됨 · ":"변경 없음 · ")+(data.message||"");
      renderIntents(data.ruleVersion, data.intents);
    } catch(e){ $("refine-status").className="err"; $("refine-status").textContent=e.message; }
    finally { $("refine").disabled=false; }
  };

  fetch("/api/status").then(function(r){return r.json();}).then(renderStatus).catch(function(){});
</script>
</body></html>`;

async function main(): Promise<number> {
	if (process.argv.includes("--selftest")) {
		const view = await runBatch({ source: "sample" });
		console.log("studio selftest — counts:", JSON.stringify(view.counts));
		for (const r of view.results) console.log(`  ${r.verdict.padEnd(13)} ${r.passed}/${r.total}  ${r.title}`);
		const ok = view.counts.pass === 2 && view.counts.fail === 1 && view.counts.needs_review === 1;
		console.log(ok ? "SELFTEST OK" : "SELFTEST MISMATCH");
		return ok ? 0 : 1;
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
