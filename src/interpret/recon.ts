/**
 * Live app reconnaissance (author-time, ground-truth). Drives the same `Page`
 * abstraction the runner uses to visit an app, optionally log in with a pool
 * account, and pull a structural scan (title, nav labels, form fields, buttons,
 * table headers) from each page's HTML. The scan is reduced by the model seam
 * into a concise Korean domain brief that a human reviews and saves as a sheet's
 * `appContext` — which then feeds AI plan authoring.
 *
 * This is author-time only: it never touches the deterministic run/verdict path,
 * so determinism (false-pass = 0) is unaffected. The structural extractor is a
 * pure function of HTML, so orchestration is unit-testable via `FakePage` +
 * `FakeModelClient` without a live browser or network.
 */

import type { Page } from "../execute/page.ts";
import type { ModelClient } from "../model/model-client.ts";

export interface ReconLink {
	label: string;
	href: string;
}

/** A structural scan of a single page. */
export interface ReconPage {
	url: string;
	title: string;
	headings: string[];
	links: ReconLink[];
	formFields: string[];
	buttons: string[];
	tableHeaders: string[];
}

export interface ReconAccount {
	username?: string;
	password?: string;
}

export interface ReconOptions {
	/** Where to start (default "/"; the app may redirect to its login page). */
	loginPath?: string;
	/** Pool account to attempt login with (best-effort; skipped when absent). */
	account?: ReconAccount;
	/** Follow internal nav links from the landing page for a deeper scan. */
	deep?: boolean;
	/** Max pages to visit when `deep` (landing counts as one). */
	navLimit?: number;
	/** Override the login-field candidate labels/placeholders. */
	usernameHints?: string[];
	passwordHints?: string[];
	loginHints?: string[];
}

export interface ReconResult {
	pages: ReconPage[];
	/** Model-reduced Korean domain brief (empty when the model returns nothing). */
	context: string;
	/** Human-readable trace of what happened (login outcome, crawl skips/failures). */
	notes: string[];
	loggedIn: boolean;
}

const DEFAULT_USER_HINTS = [
	"아이디를 입력해주세요",
	"아이디",
	"이메일",
	"이메일 주소",
	"email",
	"Username",
	"User ID",
	"ID",
];
const DEFAULT_PASS_HINTS = ["비밀번호를 입력해주세요", "비밀번호", "패스워드", "Password"];
const DEFAULT_LOGIN_HINTS = ["로그인", "로그인하기", "Log in", "Login", "Sign in", "Sign In", "Continue"];
const DEFAULT_NAV_LIMIT = 6;

function stripTags(input: string): string {
	return input
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

function tagInner(html: string, re: RegExp): string[] {
	const out: string[] = [];
	for (const m of html.matchAll(re)) {
		const text = stripTags(m[1] ?? "");
		if (text) out.push(text);
	}
	return out;
}

function attrOf(tag: string, name: string): string {
	const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
	return m ? stripTags(m[2] ?? m[3] ?? m[4] ?? "") : "";
}

function uniqCap(values: string[], cap: number): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const v of values) {
		const k = v.trim();
		if (!k || seen.has(k)) continue;
		seen.add(k);
		out.push(k);
		if (out.length >= cap) break;
	}
	return out;
}

function extractFields(html: string): string[] {
	const out: string[] = [];
	for (const m of html.matchAll(/<(?:input|textarea|select)\b[^>]*>/gi)) {
		const tag = m[0];
		if (/\btype\s*=\s*["']?(?:hidden|submit|button|reset)["']?/i.test(tag)) continue;
		const label = attrOf(tag, "placeholder") || attrOf(tag, "aria-label") || attrOf(tag, "name");
		if (label) out.push(label);
	}
	out.push(...tagInner(html, /<label\b[^>]*>([\s\S]*?)<\/label>/gi));
	return out;
}

function extractLinks(html: string): ReconLink[] {
	const seen = new Set<string>();
	const out: ReconLink[] = [];
	for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
		const label = stripTags(m[2] ?? "");
		if (!label) continue;
		const href = attrOf(`<a ${m[1] ?? ""}>`, "href");
		const key = `${label}\u0000${href}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ label, href });
		if (out.length >= 40) break;
	}
	return out;
}

/** Pure structural extraction from a page's HTML — the unit-tested core of recon. */
export function extractStructure(rawHtml: string, url = ""): ReconPage {
	// Strip <script>/<style> bodies first so template strings inside them (e.g. an inline SPA
	// that builds its login markup as a JS string) are never mistaken for real DOM elements.
	const html = rawHtml.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ");
	const buttons = [
		...tagInner(html, /<button\b[^>]*>([\s\S]*?)<\/button>/gi),
		...[...html.matchAll(/<input\b[^>]*\btype\s*=\s*["']?(?:submit|button)["']?[^>]*>/gi)].map((m) =>
			attrOf(m[0], "value"),
		),
		...tagInner(html, /<[^>]*\brole\s*=\s*["']button["'][^>]*>([\s\S]*?)<\/[^>]*>/gi),
	];
	return {
		url,
		title: stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""),
		headings: uniqCap(tagInner(html, /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi), 12),
		links: extractLinks(html),
		formFields: uniqCap(extractFields(html), 30),
		buttons: uniqCap(buttons, 20),
		tableHeaders: uniqCap(tagInner(html, /<th\b[^>]*>([\s\S]*?)<\/th>/gi), 40),
	};
}

/** A relative, same-site path we are willing to crawl (skips anchors, external, and non-nav schemes). */
function internalPath(href: string): string | null {
	const h = href.trim();
	if (!h || h.startsWith("#") || h.startsWith("//")) return null;
	if (/^(?:javascript|mailto|tel|data):/i.test(h)) return null;
	if (!h.startsWith("/")) return null;
	return h.split("#")[0] ?? h;
}

async function tryFill(page: Page, hints: string[], value: string): Promise<boolean> {
	for (const hint of hints) {
		try {
			await page.fill(hint, value);
			return true;
		} catch {
			// candidate did not match — try the next hint
		}
	}
	return false;
}

async function tryClick(page: Page, hints: string[]): Promise<boolean> {
	for (const hint of hints) {
		try {
			await page.click(hint);
			return true;
		} catch {
			// candidate did not match — try the next hint
		}
	}
	return false;
}

function renderPageForPrompt(p: ReconPage): string {
	const lines = [`PAGE ${p.url || "/"} — ${p.title || "(no title)"}`];
	const navLabels = uniqCap(
		p.links.map((l) => l.label),
		25,
	);
	if (navLabels.length) lines.push(`nav: ${navLabels.join(", ")}`);
	if (p.formFields.length) lines.push(`fields: ${p.formFields.slice(0, 25).join(", ")}`);
	if (p.buttons.length) lines.push(`buttons: ${p.buttons.slice(0, 20).join(", ")}`);
	if (p.headings.length) lines.push(`headings: ${p.headings.slice(0, 12).join(", ")}`);
	if (p.tableHeaders.length) lines.push(`table headers: ${p.tableHeaders.slice(0, 30).join(", ")}`);
	return lines.join("\n");
}

const RECON_SYSTEM =
	"You are given a structural scan of a web app (page titles, nav labels, form field labels, buttons, table headers). " +
	"Write a concise domain-context brief IN KOREAN that helps another AI author deterministic browser test steps. " +
	"Cover: the app's apparent purpose, key navigation labels, login/form field labels, primary action buttons, and any " +
	"domain vocabulary. Use 4-10 short bullet lines starting with '- '. Ground every statement in the scan — never invent " +
	"routes, labels, or features that are not present. Output ONLY the bullets, no preamble or closing.";

/** Reduce a multi-page structural scan into a concise Korean domain brief via the model seam. */
export async function reduceRecon(pages: ReconPage[], model: ModelClient): Promise<string> {
	if (pages.length === 0) return "";
	const user = pages.map(renderPageForPrompt).join("\n\n");
	const reply = await model.complete([
		{ role: "system", content: RECON_SYSTEM },
		{ role: "user", content: user },
	]);
	return reply.trim();
}

/**
 * Visit an app, optionally log in, scan its structure, and reduce it into a
 * reviewable Korean domain brief. Best-effort throughout: login and crawl
 * failures are recorded as notes rather than thrown, so a human always gets a
 * scan of whatever rendered.
 */
export async function reconApp(page: Page, model: ModelClient, opts: ReconOptions = {}): Promise<ReconResult> {
	const notes: string[] = [];
	const pages: ReconPage[] = [];

	let loggedIn = false;
	const acct = opts.account;
	if (acct && (acct.username || acct.password)) {
		// Reuse the run's login precondition so we wait for the redirect to land before scanning
		// (otherwise recon captures the login page instead of the authenticated app).
		const res = await attemptLogin(page, acct, {
			loginPath: opts.loginPath,
			usernameHints: opts.usernameHints,
			passwordHints: opts.passwordHints,
			loginHints: opts.loginHints,
		});
		loggedIn = res.ok;
		notes.push(res.ok ? "로그인 완료(로그인 폼 이탈 확인)" : `로그인 미완료 — ${res.note} (공개 화면만 스캔)`);
	} else {
		await page.goto(opts.loginPath ?? "/");
	}

	const landing = await page.snapshot();
	pages.push(extractStructure(landing.html, landing.url));

	if (opts.deep) {
		const limit = Math.max(1, opts.navLimit ?? DEFAULT_NAV_LIMIT);
		const visited = new Set<string>([landing.url.split("#")[0] ?? landing.url]);
		const queue: string[] = [];
		for (const link of pages[0]?.links ?? []) {
			const path = internalPath(link.href);
			if (path && !visited.has(path)) {
				visited.add(path);
				queue.push(path);
			}
		}
		for (const path of queue) {
			if (pages.length >= limit) break;
			try {
				await page.goto(path);
				const snap = await page.snapshot();
				pages.push(extractStructure(snap.html, snap.url));
			} catch (err) {
				notes.push(`하위 페이지 스캔 실패 ${path}: ${(err as Error).message}`);
			}
		}
	}

	const context = await reduceRecon(pages, model);
	if (!context) notes.push("모델이 컨텍스트를 반환하지 않음 — 모델 연결/쿼터를 확인하세요.");
	return { pages, context, notes, loggedIn };
}

export interface LoginResult {
	ok: boolean;
	/** Human-readable outcome for logs and the run error message. */
	note: string;
}

/**
 * Auto-login precondition. Navigates to the login entry, fills the account
 * credentials via the same field-hint ranking recon uses, submits, and verifies
 * we left the login form. Unlike reconApp's best-effort login, this reports a
 * definite ok/!ok so the runner can abort a batch when auth was required but
 * did not take (rather than letting every case fail into the review queue).
 */
export async function attemptLogin(
	page: Page,
	account: ReconAccount,
	opts: {
		loginPath?: string;
		usernameHints?: string[];
		passwordHints?: string[];
		loginHints?: string[];
		/** Max time to wait for the login form to disappear after submit (default 6000ms). */
		settleTimeoutMs?: number;
	} = {},
): Promise<LoginResult> {
	if (!account.username && !account.password) return { ok: false, note: "계정 자격증명이 비어 있습니다" };
	await page.goto(opts.loginPath ?? "/");
	const filledUser = account.username
		? await tryFill(page, opts.usernameHints ?? DEFAULT_USER_HINTS, account.username)
		: true;
	const filledPass = account.password
		? await tryFill(page, opts.passwordHints ?? DEFAULT_PASS_HINTS, account.password)
		: true;
	if (!filledUser || !filledPass) return { ok: false, note: "로그인 입력 필드(아이디/비밀번호)를 찾지 못했습니다" };
	const clicked = await tryClick(page, opts.loginHints ?? DEFAULT_LOGIN_HINTS);
	if (!clicked) return { ok: false, note: "로그인/제출 버튼을 찾지 못했습니다" };
	// Wait for the login form to disappear (server auth + redirect / SPA transition can take a few seconds).
	// Poll rather than a fixed delay so a fast login returns immediately and a slow one isn't a false failure.
	const passHints = (opts.passwordHints ?? DEFAULT_PASS_HINTS).map((h) => h.toLowerCase());
	const stillOnLoginForm = (html: string, url: string): boolean =>
		extractStructure(html, url).formFields.some((f) => passHints.some((h) => f.toLowerCase().includes(h)));
	const budgetMs = opts.settleTimeoutMs ?? 6000;
	for (let waited = 0; waited < budgetMs; waited += 500) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		const snap = await page.snapshot();
		if (!stillOnLoginForm(snap.html, snap.url)) return { ok: true, note: "로그인 완료" };
	}
	return { ok: false, note: "제출 후에도 로그인 화면에 머무름(자격증명 거부 또는 로그인 지연)" };
}
