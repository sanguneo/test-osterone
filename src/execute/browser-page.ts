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
		await this.locate(target).click({ timeout: this.timeoutMs });
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
		return p
			.getByRole("button", { name: target })
			.or(p.getByRole("link", { name: target }))
			.or(p.getByLabel(target))
			.or(p.getByPlaceholder(target))
			.or(p.getByText(target, { exact: false }))
			.or(p.locator(target))
			.first();
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
