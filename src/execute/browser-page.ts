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

import { type Browser, type BrowserContext, chromium, type Locator, type Page as PwPage } from "playwright";

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

/** Launch a standalone Chromium the caller owns and reuses across runs (avoids per-run cold starts). */
export function launchBrowser(headless = true): Promise<Browser> {
	return chromium.launch({ headless });
}

export class BrowserPage implements Page {
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
		const browser = opts.browser ?? (await chromium.launch({ headless: opts.headless ?? true, slowMo: opts.slowMo }));
		const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 800 } });
		const tracing = !!opts.trace;
		if (tracing) await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
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
		await this.pwPage.goto(url, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
	}

	async click(target: string): Promise<void> {
		const locator = this.locate(target);
		try {
			await locator.click({ timeout: this.timeoutMs });
			return;
		} catch (err) {
			// A popup/overlay may be intercepting pointer events — clear it and retry.
			await this.dismissOverlays();
			try {
				await locator.click({ timeout: this.timeoutMs });
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

	async fill(target: string, value: string): Promise<void> {
		await this.locate(target).fill(value, { timeout: this.timeoutMs });
	}

	async snapshot(): Promise<PageSnapshot> {
		const text = await this.pwPage
			.locator("body")
			.innerText()
			.catch(() => "");
		const screenshot = await this.pwPage
			.screenshot({ type: "png" })
			.then((buf) => `data:image/png;base64,${buf.toString("base64")}`)
			.catch(() => undefined);
		return { url: this.pwPage.url(), text, html: await this.pwPage.content(), screenshot };
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
		const squished = target.replace(/\s+/g, "");
		if (squished.length >= 2) {
			const flex = new RegExp(
				squished
					.split("")
					.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
					.join("\\s*"),
			);
			loc = loc
				.or(p.getByText(flex))
				.or(p.getByRole("link", { name: flex }))
				.or(p.getByRole("button", { name: flex }));
		}
		return loc.or(p.locator(target)).first();
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
