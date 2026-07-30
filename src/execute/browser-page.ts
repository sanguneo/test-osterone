/**
 * Playwright-backed headless `Page`. Implements the same contract as `FakePage`,
 * so the deterministic runner/verdict logic is unchanged. `locate` encodes the
 * self-heal candidate ranking (role -> label -> placeholder -> text -> raw css);
 * when no candidate resolves, the action throws and the runner records a heal
 * event -> needs_review (never a silent pass).
 *
 * Unit tests cover the runner via `FakePage`; this adapter's live behavior is
 * verified by the G004 benchmark against the fixture site (needs a real browser).
 */

import type { Browser, BrowserContext, Locator, Page as PwPage } from "playwright";
import { escapeRe } from "../interpret/interpret.ts";
import { DEFAULT_PHRASES } from "../interpret/rule.ts";

import type { Page, PageSnapshot } from "./page.ts";

export interface BrowserPageOptions {
	baseUrl: string;
	headless?: boolean;
	viewport?: { width: number; height: number };
	timeoutMs?: number;
	slowMo?: number;
	/** Reuse a shared browser (a fresh context is created per page); close() then only closes the context. */
	browser?: Browser;
	/** Capture a Playwright trace (screenshots+DOM snapshots+sources); per-case chunks via start/stopTrace. */
	trace?: boolean;
}

/**
 * Map a launch failure to an actionable, localized message (null if unrelated). Two distinct
 * causes reach here now that the module is loaded on demand: the browser binary was never
 * downloaded, or the `playwright` package itself is missing from the install.
 */
export function browserInstallHint(errorMessage: string): string | null {
	if (/Cannot find (?:module|package) ['"]?playwright|ERR_MODULE_NOT_FOUND/i.test(errorMessage)) {
		return "Playwright 패키지가 설치되어 있지 않습니다. 터미널에서 `bun install`을 실행한 뒤 `bun run setup`으로 브라우저를 내려받으세요.";
	}
	if (/Executable doesn't exist|playwright install|Please run the following command/i.test(errorMessage)) {
		return "Chromium 브라우저가 설치되어 있지 않습니다. 터미널에서 `npx playwright install chromium` (또는 `bun run setup`)을 실행한 뒤 다시 시도하세요.";
	}
	return null;
}

/**
 * Whitespace-tolerant matcher for a human label: Korean UI copy differs from an authored
 * hint only by spacing ("아이디를 입력해주세요" vs the live "아이디를 입력해 주세요.").
 * Returns null for targets too short to match safely.
 */
export function flexTextRe(target: string): RegExp | null {
	const squished = target.replace(/\s+/g, "");
	if (squished.length < 2) return null;
	return new RegExp(
		squished
			.split("")
			.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join("\\s*"),
	);
}

/**
 * The target with a trailing UI noun removed, or null when that changes nothing.
 *
 * A sheet names a box "이메일 입력란" while the app's only accessible name is its placeholder,
 * "이메일을 입력해주세요." — two conventions, neither a substring of the other, so every candidate
 * missed and six fills failed on fields that were right there. Stripping the noun leaves "이메일",
 * which `getByPlaceholder` matches as a substring.
 *
 * Used strictly as a *later* candidate than the exact ones, so a real label always wins; the vocabulary
 * is the same list the rule carries, not a second copy.
 */
export function withoutUiNoun(target: string): string | null {
	const nouns = [...DEFAULT_PHRASES.uiNoun].sort((a, b) => b.length - a.length).map(escapeRe);
	const stripped = target.replace(new RegExp(`\\s*(?:${nouns.join("|")})\\s*$`, "i"), "").trim();
	return stripped && stripped !== target.trim() && stripped.length >= 2 ? stripped : null;
}

/**
 * Is this target a CSS selector rather than a human label? Only `#id`, `.class`, `[attr=…]` and
 * bare tag names qualify — anything with spaces, slashes, or Korean is UI copy, and feeding that to
 * a CSS engine raises a parse error instead of simply not matching.
 */
export function looksLikeCss(target: string): boolean {
	const t = target.trim();
	if (!t || /[\s가-힣]/.test(t)) return false;
	return /^[.#[]/.test(t) || /^[a-zA-Z][\w-]*$/.test(t);
}

/**
 * Elements Playwright's `fill` can actually write to. Restricting fills to these keeps a
 * label/heading that shares the field's text (very common on Korean login forms) from winning
 * the locator race and failing the action with "Element is not an <input>".
 */
const FILLABLE_CSS =
	'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"], [contenteditable=""]';

/**
 * Playwright is loaded on demand, not at import time. `chromium.launch` is this file's only
 * runtime use of the package — everything else is types — so a dynamic import keeps the ~0.5s
 * module load (and the browser requirement itself) off every path that never opens a browser:
 * the CLI, Studio boot, sheet ingest, rule/verdict evaluation, and the unit suites that exercise
 * the pure helpers here. Cached after the first success; a failure is not cached, so a user who
 * installs the browser mid-session does not have to restart Studio.
 */
let chromiumPromise: Promise<typeof import("playwright").chromium> | null = null;
function loadChromium(): Promise<typeof import("playwright").chromium> {
	chromiumPromise ??= import("playwright").then(
		(m) => m.chromium,
		(err) => {
			chromiumPromise = null;
			throw err;
		},
	);
	return chromiumPromise;
}

/** Launch Chromium, rethrowing the cryptic missing-binary/missing-package error as a clear, actionable one. */
async function launchChromium(opts: { headless?: boolean; slowMo?: number }): Promise<Browser> {
	try {
		const chromium = await loadChromium();
		return await chromium.launch(opts);
	} catch (err) {
		const hint = browserInstallHint((err as Error).message ?? "");
		throw hint ? new Error(hint) : err;
	}
}

/** Launch a standalone Chromium the caller owns and reuses across runs (avoids per-run cold starts). */
export function launchBrowser(headless = true): Promise<Browser> {
	return launchChromium({ headless });
}

export class BrowserPage implements Page {
	/** HTTP status of the last document navigation (null when the browser served it from cache/SPA). */
	private lastStatus: number | null = null;

	private constructor(
		private readonly browser: Browser,
		private readonly context: BrowserContext,
		private readonly pwPage: PwPage,
		private readonly baseUrl: string,
		private readonly timeoutMs: number,
		private readonly ownsBrowser: boolean,
		private readonly tracing: boolean,
	) {}

	static async create(opts: BrowserPageOptions): Promise<BrowserPage> {
		const ownsBrowser = !opts.browser;
		const browser = opts.browser ?? (await launchChromium({ headless: opts.headless ?? true, slowMo: opts.slowMo }));
		const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 800 } });
		const tracing = !!opts.trace;
		// `sources: false`: the sources in a trace are this engine's own files, not the app under
		// test, so they only inflate every kept trace — and hundreds of kept traces fill a disk.
		if (tracing) await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
		const pwPage = await context.newPage();
		// Auto-dismiss native alert/confirm/beforeunload popups so they never block a test run.
		pwPage.on("dialog", (d) => void d.dismiss().catch(() => {}));
		return new BrowserPage(
			browser,
			context,
			pwPage,
			opts.baseUrl.replace(/\/$/, ""),
			opts.timeoutMs ?? 5000,
			ownsBrowser,
			tracing,
		);
	}

	async goto(path: string): Promise<void> {
		const url = path.startsWith("http") ? path : `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
		const res = await this.pwPage.goto(url, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
		// Remember the document status so the runner can tell "the route 404'd" from "the click missed".
		this.lastStatus = res ? res.status() : null;
		await this.settleApp();
	}

	/** Where the browser actually ended up (client redirects included) + the document's HTTP status. */
	async landing(): Promise<{ url: string; status: number | null }> {
		return { url: this.pwPage.url(), status: this.lastStatus };
	}

	/**
	 * Browser-level sign-out: drop cookies and web storage, then return to the entry page. A
	 * login-feature case must start signed out — otherwise it inherits the batch's shared session
	 * and there is no login form left to test.
	 */
	async resetSession(): Promise<void> {
		await this.context.clearCookies().catch(() => {});
		await this.pwPage
			.evaluate(() => {
				try {
					localStorage.clear();
					sessionStorage.clear();
				} catch {
					// storage can be blocked (about:blank, third-party rules) — cookies alone still sign us out
				}
			})
			.catch(() => {});
		await this.goto("/");
	}

	/**
	 * Client-rendered apps (Nuxt/Vue/React) return from DOMContentLoaded with an empty app shell and
	 * mount (and often client-redirect to /auth/login) milliseconds later. Waiting for the first paint
	 * here means the next action — and any snapshot-based precondition — sees the real DOM, not the shell.
	 */
	private async settleApp(): Promise<void> {
		await this.pwPage
			.waitForFunction(
				() => {
					const b = document.body;
					if (!b) return false;
					return (b.innerText || "").trim().length > 0 || !!b.querySelector("input,textarea,button,a,table,img,svg");
				},
				undefined,
				{ timeout: this.timeoutMs },
			)
			.catch(() => {});
	}

	async click(target: string, timeoutMs = this.timeoutMs): Promise<void> {
		// Prefer an interactive element (button/link/menuitem/tab/checkbox/label/placeholder) over a
		// plain text match — otherwise a heading that shares the label (e.g. an <h1>로그인</h1> above a
		// 로그인 button) wins by DOM order and the click hits dead text.
		const clickable = this.pwPage
			.getByRole("button", { name: target })
			.or(this.pwPage.getByRole("link", { name: target }))
			.or(this.pwPage.getByRole("menuitem", { name: target }))
			.or(this.pwPage.getByRole("tab", { name: target }))
			.or(this.pwPage.getByRole("checkbox", { name: target }))
			.or(this.pwPage.getByLabel(target))
			.or(this.pwPage.getByPlaceholder(target))
			.first();
		const locator = (await clickable.count().catch(() => 0)) > 0 ? clickable : this.locate(target);
		try {
			await locator.click({ timeout: timeoutMs });
			return;
		} catch (err) {
			// A popup/overlay may be intercepting pointer events — clear it and retry.
			await this.dismissOverlays();
			try {
				await locator.click({ timeout: timeoutMs });
				return;
			} catch {
				// Last resort: match the target against the live DOM's clickable text and dispatch a
				// direct DOM click (bypasses label-spacing mismatch and any leftover overlay interception).
				if (!(await this.clickByText(target))) throw err;
			}
		}
	}

	/** Grounded fallback: click the smallest visible element whose text matches the target. */
	private async clickByText(target: string): Promise<boolean> {
		const squished = target.replace(/\s+/g, "");
		if (squished.length < 2) return false;
		return await this.pwPage
			.evaluate((sq) => {
				const norm = (s: string | null) => (s || "").replace(/\s+/g, "");
				const els = [
					...document.querySelectorAll(
						'a,button,[role="button"],[role="menuitem"],[role="tab"],[role="link"],[onclick],li',
					),
				];
				let best: HTMLElement | null = null;
				let bestLen = Number.POSITIVE_INFINITY;
				for (const e of els) {
					const t = norm(e.textContent);
					if (!t.includes(sq) || t.length >= bestLen) continue;
					const r = e.getBoundingClientRect();
					if (r.width > 0 && r.height > 0) {
						best = e as HTMLElement;
						bestLen = t.length;
					}
				}
				if (!best) return false;
				best.scrollIntoView({ block: "center" });
				best.click();
				return true;
			}, squished)
			.catch(() => false);
	}

	/** Close/hide blocking onboarding & notice popups so they don't intercept clicks. */
	async dismissOverlays(): Promise<void> {
		for (const name of ["오늘 하루 보지 않기", "다시 보지 않기", "닫기", "건너뛰기", "Skip", "Close"]) {
			const closer = this.pwPage
				.getByRole("button", { name })
				.or(this.pwPage.getByText(name, { exact: false }))
				.first();
			if (await closer.count().catch(() => 0)) await closer.click({ timeout: 1000 }).catch(() => {});
		}
		// Hide any remaining large fixed/absolute high-z overlay that covers the page center.
		await this.pwPage
			.evaluate(() => {
				for (let i = 0; i < 6; i++) {
					let node: Element | null = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
					let overlay: HTMLElement | null = null;
					while (node && node !== document.body) {
						const cs = getComputedStyle(node);
						const z = Number.parseInt(cs.zIndex || "0", 10) || 0;
						if (cs.position === "fixed" && z >= 10) {
							const r = node.getBoundingClientRect();
							if (r.width > window.innerWidth * 0.5 && r.height > window.innerHeight * 0.4)
								overlay = node as HTMLElement;
						}
						node = node.parentElement;
					}
					if (!overlay) break;
					overlay.style.setProperty("display", "none", "important");
				}
			})
			.catch(() => {});
	}

	async fill(target: string, value: string, timeoutMs = this.timeoutMs): Promise<void> {
		try {
			await this.locateFillable(target).fill(value, { timeout: timeoutMs });
			return;
		} catch (err) {
			// Grounded fallback: match the target against every real input's label/placeholder/name.
			if (await this.fillByProximity(target, value)) return;
			// Last resort: the wide ranking (raw css selectors, exotic contenteditable widgets).
			try {
				await this.locate(target).fill(value, { timeout: 1000 });
				return;
			} catch {
				throw err;
			}
		}
	}

	/** Fill-specific candidate ranking: label -> placeholder -> name/id -> title, restricted to writable elements. */
	private locateFillable(target: string): Locator {
		const p = this.pwPage;
		const esc = target.replace(/["\\]/g, "\\$&");
		let loc = p
			.getByLabel(target)
			.or(p.getByPlaceholder(target))
			.or(p.locator(`[name="${esc}"], [id="${esc}"], [title="${esc}"], [aria-label="${esc}"]`));
		const flex = flexTextRe(target);
		if (flex) loc = loc.or(p.getByLabel(flex)).or(p.getByPlaceholder(flex));
		return loc.and(p.locator(FILLABLE_CSS)).first();
	}

	/**
	 * Find the visible writable field whose own metadata or nearby label text matches the target
	 * (spacing-insensitive), tag it, and let Playwright fill it so real input/change events still fire.
	 */
	private async fillByProximity(target: string, value: string): Promise<boolean> {
		const squished = target.replace(/\s+/g, "");
		if (squished.length < 2) return false;
		const marked = await this.pwPage
			.evaluate(
				({ sq, fillable }) => {
					const norm = (s: string | null | undefined) => (s || "").replace(/\s+/g, "");
					for (const stale of document.querySelectorAll("[data-osteron-fill]"))
						stale.removeAttribute("data-osteron-fill");
					const labelsOf = (el: Element): string[] => {
						const out: (string | null | undefined)[] = [
							el.getAttribute("placeholder"),
							el.getAttribute("aria-label"),
							el.getAttribute("name"),
							el.getAttribute("title"),
							el.id,
						];
						if (el.id) out.push(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent);
						out.push(el.closest("label")?.textContent);
						for (const id of (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean))
							out.push(document.getElementById(id)?.textContent);
						const group = el.closest("div,li,td,fieldset,form");
						if (group) for (const l of group.querySelectorAll("label,legend")) out.push(l.textContent);
						return out.map(norm).filter((s) => s.length >= 2);
					};
					let best: HTMLElement | null = null;
					let bestLen = Number.POSITIVE_INFINITY;
					for (const el of document.querySelectorAll(fillable)) {
						const r = el.getBoundingClientRect();
						if (!r.width || !r.height) continue;
						for (const label of labelsOf(el)) {
							if (!label.includes(sq) && !sq.includes(label)) continue;
							if (label.length >= bestLen) continue;
							best = el as HTMLElement;
							bestLen = label.length;
						}
					}
					if (!best) return false;
					best.setAttribute("data-osteron-fill", "1");
					return true;
				},
				{ sq: squished, fillable: FILLABLE_CSS },
			)
			.catch(() => false);
		if (!marked) return false;
		const hit = this.pwPage.locator("[data-osteron-fill]").first();
		try {
			await hit.fill(value, { timeout: this.timeoutMs });
			return true;
		} catch {
			return false;
		} finally {
			await this.pwPage
				.evaluate(() => {
					for (const el of document.querySelectorAll("[data-osteron-fill]")) el.removeAttribute("data-osteron-fill");
				})
				.catch(() => {});
		}
	}

	async snapshot(opts: { screenshot?: boolean } = {}): Promise<PageSnapshot> {
		const text = await this.pwPage
			.locator("body")
			.innerText()
			.catch(() => "");
		// The PNG dominates the cost (~40ms vs ~5ms for text+html, more on a busy page), and polling
		// loops re-snapshot up to a dozen times per case — they ask for it to be skipped.
		const screenshot =
			opts.screenshot === false
				? undefined
				: await this.pwPage
						.screenshot({ type: "png" })
						.then((buf) => `data:image/png;base64,${buf.toString("base64")}`)
						.catch(() => undefined);
		return {
			url: this.pwPage.url(),
			text,
			html: await this.pwPage.content(),
			fields: await this.fieldValues(),
			screenshot,
		};
	}

	/**
	 * Live values of the page's form fields, keyed by the label a user would read.
	 *
	 * Typed text is a DOM *property*, so it appears in neither `innerText` nor `content()` — which
	 * made every "입력 제한되어야 한다" case unfalsifiable. Read from the live page instead. Best
	 * effort: a detached node mid-render must not fail the snapshot the verdict depends on.
	 */
	private async fieldValues(): Promise<Record<string, string>> {
		return await this.pwPage
			.evaluate(() => {
				const out: Record<string, string> = {};
				const labelOf = (el: Element): string => {
					const id = el.getAttribute("id");
					const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : null;
					const wrapping = el.closest("label")?.textContent;
					return (
						byFor?.trim() ||
						wrapping?.trim() ||
						el.getAttribute("aria-label")?.trim() ||
						el.getAttribute("placeholder")?.trim() ||
						el.getAttribute("name")?.trim() ||
						el.tagName.toLowerCase()
					);
				};
				const nodes = document.querySelectorAll<HTMLElement>(
					'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, [contenteditable="true"]',
				);
				let i = 0;
				for (const el of nodes) {
					const v =
						el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el.innerText ?? "");
					// Empty values are kept on purpose: a field assertion has to tell "the app cleared what I
					// typed" from "there is no such field", and only presence in this map answers that. Text
					// assertions filter the empties out themselves.
					// Distinct keys for repeated labels so one field never masks another's value.
					const key = labelOf(el);
					out[key in out ? `${key}#${++i}` : key] = v;
				}
				return out;
			})
			.catch(() => ({}));
	}

	/** Self-heal candidate ranking: try the most specific locator first, widen to raw css last. */
	private locate(target: string): Locator {
		const p = this.pwPage;
		let loc = p
			.getByRole("button", { name: target })
			.or(p.getByRole("link", { name: target }))
			.or(p.getByRole("menuitem", { name: target }))
			.or(p.getByRole("tab", { name: target }))
			.or(p.getByRole("checkbox", { name: target }))
			.or(p.getByLabel(target))
			.or(p.getByPlaceholder(target))
			.or(p.getByText(target, { exact: false }));
		// Whitespace-tolerant fallback: Korean labels often differ only by spacing
		// (e.g. "전체 결재문서" vs "전체결재문서" vs "전체 결재 문서").
		const flex = flexTextRe(target);
		if (flex) {
			loc = loc
				.or(p.getByText(flex))
				.or(p.getByRole("link", { name: flex }))
				.or(p.getByRole("button", { name: flex }));
		}
		// Raw CSS only when the target actually is one. A human label like "아이디/비밀번호 찾기"
		// makes Playwright throw a *selector parse* error at action time, which kills the whole
		// `.or()` chain — including the role/text candidates that would have matched.
		return (looksLikeCss(target) ? loc.or(p.locator(target)) : loc).first();
	}

	/** Begin a per-case trace chunk (no-op unless tracing was enabled). */
	async startTrace(): Promise<void> {
		if (this.tracing) await this.context.tracing.startChunk();
	}

	/** End the current chunk: export to `path`, or discard when `path` is omitted. */
	async stopTrace(path?: string): Promise<void> {
		if (this.tracing) await this.context.tracing.stopChunk(path ? { path } : {});
	}

	async close(): Promise<void> {
		if (this.tracing) await this.context.tracing.stop().catch(() => {});
		await this.context.close();
		if (this.ownsBrowser) await this.browser.close();
	}
}
