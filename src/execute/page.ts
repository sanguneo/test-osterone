/**
 * Page abstraction. The runner drives this interface, so verdict logic is
 * browser-agnostic and unit-testable via `FakePage`. The real Playwright-backed
 * `BrowserPage` (headless) implements the same interface and is exercised by
 * integration/benchmark runs, not these deterministic unit tests.
 */

export interface PageSnapshot {
	url: string;
	/** Visible text content used for text assertions. */
	text: string;
	/** DOM/HTML snapshot used for evidence + content-addressed refs. */
	html: string;
	/** Optional base64 PNG data URL (real browser only) — evidence for human review. */
	screenshot?: string;
}

export interface Page {
	goto(path: string): Promise<void>;
	click(target: string): Promise<void>;
	fill(target: string, value: string): Promise<void>;
	snapshot(): Promise<PageSnapshot>;
}

export interface FakeAction {
	kind: "goto" | "click" | "fill";
	target: string;
	value?: string;
}

/**
 * Deterministic scripted page. The reducer maps (action, state, inputs) -> next
 * snapshot. Throwing from the reducer simulates an unactionable target, which the
 * runner records as a heal event (never a silent pass).
 */
export class FakePage implements Page {
	private state: PageSnapshot;
	private readonly inputs: Record<string, string> = {};

	constructor(
		initial: PageSnapshot,
		private readonly reducer: (action: FakeAction, state: PageSnapshot, inputs: Record<string, string>) => PageSnapshot,
	) {
		this.state = { ...initial };
	}

	async goto(path: string): Promise<void> {
		this.state = this.reducer({ kind: "goto", target: path }, this.state, this.inputs);
	}

	async click(target: string): Promise<void> {
		this.state = this.reducer({ kind: "click", target }, this.state, this.inputs);
	}

	async fill(target: string, value: string): Promise<void> {
		this.inputs[target] = value;
		this.state = this.reducer({ kind: "fill", target, value }, this.state, this.inputs);
	}

	async snapshot(): Promise<PageSnapshot> {
		return { ...this.state };
	}
}
