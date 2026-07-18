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
}

export class BrowserPage implements Page {
	private constructor(
		private readonly browser: Browser,
		private readonly context: BrowserContext,
		private readonly pwPage: PwPage,
		private readonly baseUrl: string,
		private readonly timeoutMs: number,
	) {}

	static async create(opts: BrowserPageOptions): Promise<BrowserPage> {
		const browser = await chromium.launch({ headless: opts.headless ?? true });
		const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 800 } });
		const pwPage = await context.newPage();
		return new BrowserPage(browser, context, pwPage, opts.baseUrl.replace(/\/$/, ""), opts.timeoutMs ?? 5000);
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
		return { url: this.pwPage.url(), text, html: await this.pwPage.content() };
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

	async close(): Promise<void> {
		await this.context.close();
		await this.browser.close();
	}
}
