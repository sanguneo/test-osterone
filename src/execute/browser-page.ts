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
import { DEFAULT_PHRASES, withoutUiNoun } from "../interpret/rule.ts";

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
	/**
	 * The sheet's vocabulary, so the two things this adapter reads words for — which trailing noun is a
	 * UI kind ("입력란"), and what a dismissable overlay's close control is called — are teachable per
	 * sheet like the rest of the judgement vocabulary. Defaults when omitted.
	 */
	phrases?: Record<string, string[]>;
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
 * How the engine answers a native dialog so it never blocks a run: `beforeunload` is accepted
 * (leave the page — dismissing one *cancels* the navigation that raised it, and a dirty form then
 * aborts every goto until the batch dies), everything else is dismissed (a dismissed confirm
 * refuses the destructive action it guards).
 */
export function dialogAnswer(type: string): "accept" | "dismiss" {
	return type === "beforeunload" ? "accept" : "dismiss";
}

/**
 * Elements Playwright's `fill` can actually write to. Restricting fills to these keeps a
 * label/heading that shares the field's text (very common on Korean login forms) from winning
 * the locator race and failing the action with "Element is not an <input>".
 */
const FILLABLE_CSS =
	'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"], [contenteditable=""]';

/** One writable field as the page describes itself: the key a snapshot uses, plus every name it answers to. */
export interface FieldEntry {
	index: number;
	key: string;
	names: string[];
}

/**
 * Which field a fill target names, out of the names each field answers to.
 *
 * The rule is the one this used to run inside the browser, lifted out so it can be tested: a name
 * matches when either string contains the other once spacing is ignored — a sheet writes "이메일" where
 * the app renders "이메일을 입력해 주세요." — and the *shortest* matching name across all fields wins,
 * because a longer name that merely contains the target has the weaker claim on it.
 *
 * Kept pure on purpose. This is the exact spot where a too-generous match answers for the wrong box: a
 * stem match once resolved "아이디 입력란" to a field the case had never typed into, and its emptiness
 * read as a working input limit on two cases whose recorded defect was that the limit does not work.
 */
export function bestFieldMatch(target: string, fields: readonly FieldEntry[]): FieldEntry | null {
	const want = target.replace(/\s+/g, "");
	if (want.length < 2) return null;
	let best: FieldEntry | null = null;
	let bestLen = Number.POSITIVE_INFINITY;
	for (const field of fields) {
		for (const raw of field.names) {
			const name = raw.replace(/\s+/g, "");
			if (name.length < 2 || name.length >= bestLen) continue;
			if (!name.includes(want) && !want.includes(name)) continue;
			best = field;
			bestLen = name.length;
		}
	}
	return best;
}

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
		private readonly phrases: Record<string, string[]>,
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
		// Native popups must never block a run, but the kinds part ways. Dismissing an alert/confirm is
		// the safe answer (a dismissed confirm refuses the destructive action it guards). Dismissing a
		// `beforeunload` means "stay on the page" — it cancels the navigation that raised it, and the
		// dialog re-arms on the next one. Measured: an editor screen arms beforeunload once typed into,
		// one dirty editor left behind by a case turned every later `goto` — preconditions, login
		// retries, resetSession — into net::ERR_ABORTED, holding 66 of 98 cases two nights in a row at
		// the same sheet position. Accepting is what a user does: leave the page, lose the draft.
		pwPage.on("dialog", (d) => void (dialogAnswer(d.type()) === "accept" ? d.accept() : d.dismiss()).catch(() => {}));
		return new BrowserPage(
			browser,
			context,
			pwPage,
			opts.baseUrl.replace(/\/$/, ""),
			opts.timeoutMs ?? 5000,
			ownsBrowser,
			tracing,
			{ ...DEFAULT_PHRASES, ...(opts.phrases ?? {}) },
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
		// Prefer an interactive element (button/link/menuitem/tab/radio/checkbox/label/placeholder) over
		// a plain text match — otherwise a heading that shares the label (e.g. an <h1>로그인</h1> above a
		// 로그인 button) wins by DOM order and the click hits dead text.
		const clickable = this.pwPage
			.getByRole("button", { name: target })
			.or(this.pwPage.getByRole("link", { name: target }))
			.or(this.pwPage.getByRole("menuitem", { name: target }))
			.or(this.pwPage.getByRole("tab", { name: target }))
			.or(this.pwPage.getByRole("checkbox", { name: target }))
			.or(this.pwPage.getByRole("radio", { name: target }))
			.or(this.pwPage.getByLabel(target))
			.or(this.pwPage.getByPlaceholder(target))
			.first();
		const named = (await clickable.count().catch(() => 0)) > 0 ? clickable : this.locate(target);
		// A sheet names a control by its kind where the app paints only the noun: "소속 그룹 필터" for a
		// section the app labels 소속그룹, "이메일 입력란" for a box labelled 이메일. Strictly a later
		// candidate — used only when *nothing* matched the target as written, so a real label always wins.
		// (`withoutUiNoun` documented itself as exactly this and was wired to nothing.)
		const stripped = withoutUiNoun(target, { phrases: this.phrases });
		const locator = stripped && (await named.count().catch(() => 0)) === 0 ? this.locate(stripped) : named;
		try {
			await locator.click({ timeout: timeoutMs });
			return;
		} catch (err) {
			// A styled radio/checkbox hides its real <input>; its <label> is the only clickable surface.
			// Tried before the overlay sweep on purpose: that sweep presses "닫기" and hides big fixed
			// layers, which on this app means closing the very dialog the radio lives in.
			if (await this.clickControlLabel(target, timeoutMs)) return;
			// A popup/overlay may be intercepting pointer events — clear it and retry.
			await this.dismissOverlays(target);
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

	/**
	 * Click the surface that actually operates a radio/checkbox when the control itself refuses clicks.
	 *
	 * A styled radio keeps the real `<input>` in the DOM at `opacity: 0` and paints its `<label>` on top.
	 * The input owns the accessible name, so every name-based candidate resolves to it — and Playwright
	 * then refuses to click an invisible element. Measured on the account editor (`상태` = 활성/비활성):
	 * `getByRole("radio", { name: "비활성" })` resolves, both `click()` and `check()` time out, and
	 * clicking `label[for="radio-1"]` flips the control. Two cases died on a control that was right there.
	 *
	 * Only the label of the *exactly* named control is used — no text search, no nearest neighbour. A
	 * radio we cannot name is a radio we would be guessing at, and a guessed click answers for the wrong
	 * control, which is always the false-pass direction. No label, no click: the caller keeps failing.
	 */
	private async clickControlLabel(target: string, timeoutMs: number): Promise<boolean> {
		const p = this.pwPage;
		const control = p
			.getByRole("radio", { name: target, exact: true })
			.or(p.getByRole("checkbox", { name: target, exact: true }))
			.first();
		if ((await control.count().catch(() => 0)) === 0) return false;
		const id = await control.getAttribute("id").catch(() => null);
		// `label[for=…]` names the control from outside; a wrapping label contains it. Nothing else counts.
		const label = id
			? p.locator(`label[for="${id.replace(/["\\]/g, "\\$&")}"]`)
			: control.locator("xpath=ancestor::label[1]");
		if ((await label.count().catch(() => 0)) === 0) return false;
		return await label
			.first()
			.click({ timeout: timeoutMs })
			.then(() => true)
			.catch(() => false);
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
					// A disabled control is not a click target. Playwright's own click refuses it (that is
					// why this fallback was reached), and dispatching a DOM click at it reports a success
					// the app never saw. Measured (NO 15/21): the login form disables 로그인 until both
					// fields hold text, the preparation had filled only 아이디, and the forced click
					// "succeeded" into a page that never changed — a fail on a popup that was never asked
					// for. Failing the action instead routes the case to review as the heal it really is.
					if ((e as HTMLButtonElement).disabled || e.getAttribute("aria-disabled") === "true") continue;
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

	/**
	 * Close/hide blocking onboarding & notice popups so they don't intercept clicks.
	 *
	 * `target` is what the caller was trying to reach, and it is what keeps this from eating the app.
	 * Measured on the account editor: the sweep's own rule (large, fixed, high z, covers the centre)
	 * describes `div.modal-dim` — the dialog's backdrop — exactly, so hiding it took the dialog with it
	 * ("계정 수정" present before the sweep, gone after). Every failed click inside a dialog was
	 * destroying the screen it was about to retry on, which made step ① of the recovery ladder
	 * guarantee its own failure.
	 *
	 * So the sweep only runs when it could actually uncover something: the target has to be on the page
	 * *and* outside the layer being hidden. A target that is nowhere has nothing to uncover, and a
	 * target inside the layer means the layer is not in the way — it is where the case is working.
	 */
	async dismissOverlays(target?: string): Promise<void> {
		for (const name of this.phrases.overlayCloser ?? []) {
			const closer = this.pwPage
				.getByRole("button", { name })
				.or(this.pwPage.getByText(name, { exact: false }))
				.first();
			if (await closer.count().catch(() => 0)) await closer.click({ timeout: 1000 }).catch(() => {});
		}
		// Hide any remaining large fixed/absolute high-z overlay that covers the page center.
		await this.pwPage
			.evaluate((wanted) => {
				const norm = (s: string | null | undefined) => (s || "").replace(/\s+/g, "");
				const want = norm(wanted);
				const reachable = (el: Element): boolean => {
					if (!want) return false;
					if (norm(el.textContent).includes(want)) return true;
					for (const a of ["placeholder", "aria-label", "title", "name"]) {
						if ([...el.querySelectorAll(`[${a}]`)].some((n) => norm(n.getAttribute(a)).includes(want))) return true;
					}
					return false;
				};
				// Nothing on the page answers to the target, so there is nothing under an overlay to reveal.
				if (want && !reachable(document.body)) return;
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
					// The target lives in here: this is the case's own screen, not something in front of it.
					if (reachable(overlay)) break;
					overlay.style.setProperty("display", "none", "important");
				}
			}, target)
			.catch(() => {});
	}

	/**
	 * Click the nth row of the page's primary data list.
	 *
	 * Candidates in order of how certain they are to be a row: a real `tbody tr`, an ARIA row, then a
	 * list item. Rows that are visibly a header or an empty-state message are excluded — clicking "조회
	 * 결과가 없습니다" would report a reached state that was never reached.
	 *
	 * Scoped to the frontmost layer when a dialog is up. Measured on the 기관 생성 dialog: its group list
	 * is `ul > li`, but so is the sidebar nav behind the backdrop, and the nav comes first in document
	 * order — so "임의 항목 선택" spent its whole budget trying to click a menu item nobody could reach.
	 * A list the user cannot even see is not the list the case is talking about.
	 *
	 * Fails when no row matches rather than falling back to something clickable: "임의 계정 선택" that
	 * silently clicked a filter chip would be worse than the miss it replaced.
	 */
	async clickRow(nth: number, timeoutMs = this.timeoutMs): Promise<void> {
		const p = this.pwPage;
		const scope = (await this.markFrontmostLayer()) ? "[data-osteron-layer] " : "";
		try {
			// The frontmost layer first, then the whole page. Preferring the dialog is what stops the nav
			// from answering; falling back keeps every page without one behaving exactly as before, so a
			// layer detected where there is no dialog can cost nothing.
			for (const within of scope ? [scope, ""] : [""]) {
				const candidates = [
					p.locator(`${within}table tbody tr`),
					p.locator(`${within}[role="row"]`),
					p.locator(`${within}ul > li, ${within}ol > li`),
				];
				for (const group of candidates) {
					const rows = group.filter({ hasNot: p.locator("th") });
					const count = await rows.count().catch(() => 0);
					if (count < nth) continue;
					const row = rows.nth(nth - 1);
					// A row with no text is a spacer; one with a single cell is usually the "no results" line.
					const text = ((await row.innerText().catch(() => "")) ?? "").trim();
					if (!text) continue;
					if (
						await row.click({ timeout: timeoutMs }).then(
							() => true,
							() => false,
						)
					)
						return;
				}
			}
			throw new Error(`no data row #${nth} on this page (looked for table rows, ARIA rows, list items)`);
		} finally {
			if (scope) await this.clearLayerMark();
		}
	}

	/**
	 * Mark the dialog/overlay the user is looking at, so a search can be scoped to it; false when the
	 * page has no such layer and the whole document is the scope.
	 *
	 * Same structural signal the overlay sweep uses — a large, fixed, high-z element covering the
	 * centre — because that is what "in front of everything else" means without an app-specific class
	 * list. `[role=dialog]`/`aria-modal` would be nicer and this app carries neither.
	 */
	private async markFrontmostLayer(): Promise<boolean> {
		return await this.pwPage
			.evaluate(() => {
				for (const stale of document.querySelectorAll("[data-osteron-layer]"))
					stale.removeAttribute("data-osteron-layer");
				let node: Element | null = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
				let layer: HTMLElement | null = null;
				while (node && node !== document.body) {
					const cs = getComputedStyle(node);
					const z = Number.parseInt(cs.zIndex || "0", 10) || 0;
					if ((cs.position === "fixed" || cs.position === "absolute") && z >= 10) {
						const r = node.getBoundingClientRect();
						if (r.width > window.innerWidth * 0.3 && r.height > window.innerHeight * 0.2) layer = node as HTMLElement;
					}
					node = node.parentElement;
				}
				if (!layer) return false;
				layer.setAttribute("data-osteron-layer", "1");
				return true;
			})
			.catch(() => false);
	}

	private async clearLayerMark(): Promise<void> {
		await this.pwPage
			.evaluate(() => {
				for (const el of document.querySelectorAll("[data-osteron-layer]")) el.removeAttribute("data-osteron-layer");
			})
			.catch(() => {});
	}

	async fill(target: string, value: string, timeoutMs = this.timeoutMs): Promise<string | undefined> {
		try {
			const loc = this.locateFillable(target);
			await loc.fill(value, { timeout: timeoutMs });
			return await this.landedKeyOf(loc);
		} catch (err) {
			// Grounded fallback: match the target against every real input's label/placeholder/name.
			const proximate = await this.fillByProximity(target, value);
			if (proximate !== null) return proximate;
			// Last resort: the wide ranking (raw css selectors, exotic contenteditable widgets).
			try {
				const loc = this.locate(target);
				await loc.fill(value, { timeout: 1000 });
				return await this.landedKeyOf(loc);
			} catch {
				throw err;
			}
		}
	}

	/**
	 * The snapshot key of the element a locator just filled — the name the verdict will look up.
	 *
	 * The write and the read have to agree on which box they mean, and the locator paths cannot say by
	 * themselves: `getByPlaceholder` can satisfy a fill on an element whose snapshot key is a row label,
	 * or on a same-named box on the wrong screen. Measured (NO 114): the typed value landed where the
	 * check never looked, an empty same-named field answered instead, and a limit a human recorded as
	 * broken passed. Tag the element, let `readForm` name it with the same rule the snapshot uses.
	 * Best effort: an undefined landing makes the verdict fail closed, never pass.
	 */
	private async landedKeyOf(locator: Locator): Promise<string | undefined> {
		const tagged = await locator
			.evaluate((el) => el.setAttribute("data-osteron-landed", "1"))
			.then(
				() => true,
				() => false,
			);
		if (!tagged) return undefined;
		try {
			return (await this.readForm(false)).landed;
		} finally {
			await this.pwPage
				.evaluate(() => {
					for (const el of document.querySelectorAll("[data-osteron-landed]"))
						el.removeAttribute("data-osteron-landed");
				})
				.catch(() => {});
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
	 * Find the writable field the target names, fill it, and return its snapshot key — or null when
	 * nothing answered to the name or the write failed.
	 *
	 * Reads the page through the same `readForm` the snapshot uses, so the field a fill writes to and
	 * the field a `fieldAtMost`/`fieldExcludes` check later looks up are one and the same by
	 * construction. They used to be resolved by two separate rules, and on the account editor they
	 * disagreed: the fill landed on `input[name=email]` (matched through its placeholder) while the
	 * check asked for "이메일" and was told `field "이메일" not on screen`.
	 */
	private async fillByProximity(target: string, value: string): Promise<string | null> {
		if (target.replace(/\s+/g, "").length < 2) return null;
		const form = await this.readForm(true);
		// Same "later candidate" rule as the click path: the target as written first, and only if nothing
		// answers to it, the target with a trailing UI noun removed — a sheet writes "이메일 입력란" where
		// the app renders only "이메일".
		const stripped = withoutUiNoun(target, { phrases: this.phrases });
		const hit = bestFieldMatch(target, form.writable) ?? (stripped ? bestFieldMatch(stripped, form.writable) : null);
		try {
			if (!hit) return null;
			await this.pwPage.locator(`[data-osteron-field="${hit.index}"]`).fill(value, { timeout: this.timeoutMs });
			return hit.key;
		} catch {
			return null;
		} finally {
			await this.pwPage
				.evaluate(() => {
					for (const el of document.querySelectorAll("[data-osteron-field]")) el.removeAttribute("data-osteron-field");
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
		const form = await this.readForm(false);
		return {
			url: this.pwPage.url(),
			text,
			html: await this.pwPage.content(),
			fields: form.fields,
			controls: form.controls,
			fieldLimits: form.limits,
			screenshot,
		};
	}

	/**
	 * Read every form control the page shows: what is typed, what is selected, and every name each
	 * writable field answers to.
	 *
	 * `fields` carries what is typed: text is a DOM *property*, so it appears in neither `innerText` nor
	 * `content()` — which made every "입력 제한되어야 한다" case unfalsifiable. `controls` carries what is
	 * selected, which the same read cannot express: a radio's `value` is a fixed attribute, identical
	 * whether or not it is the chosen one. `writable` carries the aliases a fill target may use, so the
	 * fill and the later field check resolve the same element instead of disagreeing about its name.
	 *
	 * One evaluate for all three, so a snapshot costs a single round trip and every map describes the
	 * same instant. `tag` marks each writable field with its index for the fill path, and the caller
	 * removes the marks. Best effort: a detached node mid-render must not fail the snapshot the verdict
	 * depends on.
	 */
	private async readForm(tag: boolean): Promise<{
		fields: Record<string, string>;
		controls: Record<string, boolean>;
		limits: Record<string, number>;
		writable: FieldEntry[];
		/** Snapshot key of the element carrying `data-osteron-landed` — how a fill names where it wrote. */
		landed?: string;
	}> {
		return await this.pwPage
			.evaluate(
				({ mark, fillable }) => {
					const fields: Record<string, string> = {};
					const controls: Record<string, boolean> = {};
					const limits: Record<string, number> = {};
					let landed: string | undefined;
					const writable: { index: number; key: string; names: string[] }[] = [];
					const text = (s: string | null | undefined) => (s ?? "").trim();
					/**
					 * The label of the form row that owns this control — and only when it owns exactly this
					 * one writable control.
					 *
					 * Measured on the account editor: `<label class="form-label">연락처</label>` sits in
					 * `div.form-item`, while the input's own `closest("div")` is `div.form-input-wrap`, which
					 * holds no label at all — so "연락처" matched nothing and three cases failed to type into a
					 * box that was on screen. Climbing further is not the answer either: one level up,
					 * `div.form-group-modal` carries all nine labels of the dialog, and letting 연락처 answer
					 * for 이메일 is exactly the wrong-box match this engine has already had to revert twice.
					 * Stopping where a second writable control appears is what keeps the name unambiguous.
					 *
					 * Only a *direct-child*, bare label that comes *before* the control counts. Measured on the
					 * 소속그룹 row: the bare "전체" heading sits nested inside an inner wrapper while
					 * `<label>소속그룹</label>` is a direct child of the row, so a plain descendant search named
					 * the search box "전체" and the AI repair had to re-point every fill at "그룹명을 검색해
					 * 주세요." — three model round trips a run, each a heal event capping the case at
					 * needs_review. A label nested inside another component belongs to that component, one
					 * that belongs to a control is that control's name, and one rendered below the box is a
					 * heading for what follows rather than a name for what precedes it.
					 */
					const rowLabel = (el: Element): string => {
						for (let row = el.parentElement; row && row !== document.body; row = row.parentElement) {
							if (row.querySelectorAll(fillable).length > 1) return "";
							let found = "";
							for (const l of row.children) {
								if (l.tagName !== "LABEL" && l.tagName !== "LEGEND") continue;
								if (l.getAttribute("for") || l.querySelector("input,select,textarea")) continue;
								if (!(l.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
								// Keep the closest preceding one.
								found = text(l.textContent) || found;
							}
							if (found) return found;
						}
						return "";
					};
					const nodes = document.querySelectorAll<HTMLElement>(
						'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, [contenteditable="true"]',
					);
					let i = 0;
					for (const el of nodes) {
						const id = el.getAttribute("id");
						const byFor = id ? text(document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent) : "";
						const wrapping = text(el.closest("label")?.textContent);
						const row = rowLabel(el);
						// A visible <label> beats instructional text: the sheet writes "연락처", the app renders
						// "'-' 를 제외한 번호를 입력해 주세요." as the placeholder, and only one of those is a name.
						const key =
							byFor ||
							wrapping ||
							row ||
							text(el.getAttribute("aria-label")) ||
							text(el.getAttribute("placeholder")) ||
							text(el.getAttribute("name")) ||
							el.tagName.toLowerCase();
						const v =
							el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el.innerText ?? "");
						// Empty values are kept on purpose: a field assertion has to tell "the app cleared what I
						// typed" from "there is no such field", and only presence in this map answers that. Text
						// assertions filter the empties out themselves.
						// Distinct keys for repeated labels so one field never masks another's value.
						const finalKey = key in fields ? `${key}#${++i}` : key;
						fields[finalKey] = v;
						// A fill tagged this element: report the key it ended up under, deduped and all, so the
						// verdict reads exactly the box that was written — not the first one sharing its name.
						if (el.hasAttribute("data-osteron-landed")) landed = finalKey;
						// `maxLength` is -1 unless the control declares one, and a declared one decides a length
						// check before the case runs — the verdict layer has to know it was not free to fail.
						if (el instanceof HTMLInputElement && el.maxLength >= 0) limits[finalKey] = el.maxLength;
						if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")) {
							// A styled toggle is an invisible input plus a painted label, so the label is both the
							// only thing a reader sees and the only name the sheet can be quoting.
							controls[key in controls ? `${key}#${++i}` : key] = el.checked;
							continue;
						}
						if (!el.matches(fillable)) continue;
						const r = el.getBoundingClientRect();
						if (!r.width || !r.height) continue;
						const index = writable.length;
						if (mark) el.setAttribute("data-osteron-field", String(index));
						writable.push({
							index,
							// The deduped snapshot key, so what the fill reports and what the verdict looks up can
							// never disagree about which of two same-labelled boxes is meant.
							key: finalKey,
							names: [
								byFor,
								wrapping,
								row,
								text(el.getAttribute("aria-label")),
								text(el.getAttribute("placeholder")),
								text(el.getAttribute("name")),
								text(el.getAttribute("title")),
								text(id),
							].filter(Boolean),
						});
					}
					return { fields, controls, limits, writable, landed };
				},
				{ mark: tag, fillable: FILLABLE_CSS },
			)
			.catch(() => ({ fields: {}, controls: {}, limits: {}, writable: [] }));
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
			.or(p.getByRole("radio", { name: target }))
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
