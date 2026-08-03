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
	/**
	 * Current values of the page's form fields, keyed by the label a user sees.
	 *
	 * The DOM's text content never contains what someone typed — an `<input>`'s live value is a
	 * property, not text — so a case like "12자 초과 입력 → 입력 제한되어야 한다" was unverifiable:
	 * `textNotIncludes: <the typed string>` passed whether the app restricted the input or not. On
	 * the sheet this engine was built for, 57 of 652 cases are exactly that shape.
	 *
	 * Transient on purpose: assertions read it and nothing persists it. Evidence, baselines and
	 * review cards all use `text`, so a typed password never reaches disk or a review card.
	 */
	fields?: Record<string, string>;
	/**
	 * Whether each radio/checkbox on the page is selected, keyed by the label a user reads.
	 *
	 * Kept apart from `fields` because a toggle's `value` is a fixed attribute ("true", "on") that says
	 * nothing about its state — reading it is how "활성 라디오 버튼 선택되어야 한다" would look satisfied
	 * on a screen where nothing is selected at all. Presence in the map is meaningful the same way it is
	 * for `fields`: a control that is absent is not a control that is off.
	 */
	controls?: Record<string, boolean>;
	/**
	 * The length limit a field's own control declares (`maxlength`), keyed like `fields`.
	 *
	 * A limit the browser enforces decides a `fieldAtMost` check before the case runs: `fill` cannot put
	 * 260 characters into a box that declares 255, so "the value is within the limit" is a fact about the
	 * browser, not a finding about the app. Measured on a case whose recorded defect is that the limit
	 * does not work — it passed.
	 */
	fieldLimits?: Record<string, number>;
	/**
	 * What the live screen will actually respond to a click on, named the way a reader would name it.
	 *
	 * Computed in the browser, which is the whole point: an app's dropdown trigger is often a `div`
	 * with a class, no role, no aria-label and no text of its own, and the only thing marking it as
	 * clickable is `cursor: pointer` — invisible to any scan that parses the HTML string. Probed live:
	 * the account menu that a case has to open is exactly that shape, and it appears here as the
	 * username it wraps, which a plain text locator then clicks successfully.
	 *
	 * Innermost wins, so a clickable row does not swallow the button inside it.
	 */
	clickables?: string[];
	/** Optional base64 PNG data URL (real browser only) — evidence for human review. */
	screenshot?: string;
}

export interface Page {
	goto(path: string): Promise<void>;
	/**
	 * `timeoutMs` overrides the page's default for this one action. The runner spends a short budget
	 * on the first try (a present element resolves immediately) and the full one after recovery, so a
	 * target that simply does not exist costs seconds instead of tens of seconds across a batch.
	 */
	click(target: string, timeoutMs?: number): Promise<void>;
	/**
	 * Type into the field the target names.
	 *
	 * May return the snapshot key of the element actually written — the same key `fields` uses — so the
	 * verdict can ask "is the box I typed into empty?" instead of "is any box by this name empty?".
	 * Measured (NO 114): a case typed 한글ABC!@# to prove an input limit, the fill landed somewhere the
	 * check never looked, and an empty same-named field elsewhere read as the limit working — on a case
	 * whose recorded defect is that it does not. A `void` return means the implementation cannot say,
	 * and the runner then trusts the target as written (the deterministic test double's semantics).
	 */
	// biome-ignore lint/suspicious/noConfusingVoidType: `void` (not `undefined`) is what keeps every existing `Promise<void>` implementation assignable — reporting a landing is opt-in.
	fill(target: string, value: string, timeoutMs?: number): Promise<string | void>;
	/**
	 * Click a row of the page's primary data list, 1-based.
	 *
	 * "임의 계정 선택" — pick any account from the list — is the single most common instruction on the
	 * sheet this engine exists for: 124 of 652 cases, thirty times more than every ordinal ("첫 번째",
	 * "마지막") combined. There is no label to click, so a label-only action vocabulary cannot express it
	 * at all, and every one of those cases failed on a target that was never a target.
	 *
	 * "Any" resolves to the first row, deterministically: a run that picks a different row each time is
	 * not a regression gate. Implementations must fail rather than click something that is not a row.
	 *
	 * Optional like the other capabilities here, so an existing `Page` implementation still compiles —
	 * the runner reports the gap instead of skipping the step, because a setup step that quietly does
	 * nothing is how a case gets a verdict from the wrong screen.
	 */
	clickRow?(nth: number, timeoutMs?: number): Promise<void>;
	/**
	 * Current page state. Pass `{ screenshot: false }` in polling loops: the PNG is ~90% of the
	 * cost and only the evidence snapshot (and vision) actually needs it.
	 */
	snapshot(opts?: { screenshot?: boolean }): Promise<PageSnapshot>;
	/**
	 * Optional deterministic recovery hook: close whatever is intercepting input (onboarding
	 * modal, notice popup, overlay) so a failed action can be retried. Only the real
	 * `BrowserPage` implements it; `FakePage` omits it, so unit tests retry immediately.
	 *
	 * `target` is what the caller was about to click. An implementation must not hide a layer that
	 * *contains* the target: measured, the sweep's own rule matches a dialog's backdrop exactly, so a
	 * failed click inside a dialog was closing the dialog it was about to retry in.
	 */
	dismissOverlays?(target?: string): Promise<void>;
	/**
	 * Optional post-navigation truth: where the browser actually ended up and the document's HTTP
	 * status. Cheap by design (no screenshot) so the runner can verify every `goto` landed on the
	 * route it asked for — a silent redirect to a login/error page is otherwise invisible.
	 */
	landing?(): Promise<{ url: string; status: number | null }>;
	/**
	 * Optional browser-level sign-out (clear cookies + web storage, return to the entry page) so a
	 * login-feature case starts from a signed-out state instead of inheriting the shared session.
	 */
	resetSession?(): Promise<void>;
	/**
	 * Optional: requests the page made that never came back with a usable answer — a transport failure
	 * or a 5xx — newest last, and cleared by the caller once read.
	 *
	 * A screen tells you nothing about why a submit did nothing. Measured on a live outage: the login
	 * form filled correctly, the button enabled, the click landed, and the app simply stayed put — so
	 * the engine reported "credentials refused or a slow login", because that is all a screen can say.
	 * The truth was one layer below the DOM: the login POST goes to a different host and came back
	 * `500 Internal server error`, which also failed its CORS preflight, so the browser never sent the
	 * real request. Five probes to learn what the browser already knew.
	 *
	 * Diagnostic only. Nothing here decides a verdict; it lets a failure explain itself.
	 */
	requestFailures?(): string[];
	/**
	 * Optional: did the page send anything but a GET since the last read — a POST, PUT, PATCH or
	 * DELETE — and to where. Cleared by the caller once read.
	 *
	 * This is what makes a parallel schedule decidable. Two cases may share an app only if neither
	 * changes what the other reads, and the honest test for that is not the label on a button: the
	 * same Korean noun sits on the control that *opens* a create dialog and on the one that saves it,
	 * so a vocabulary reads `신규 계정 생성` and `기관명 중복확인` as writes when both are lookups.
	 * Measured over a 98-case sheet, that guess named 8 writers and every one of them was a read. The
	 * request the app actually sent is not a guess.
	 */
	serverWrites?(): string[];
	/**
	 * Optional per-case Playwright trace chunk hooks. Only the real `BrowserPage`
	 * implements them; `FakePage` omits them so unit tests are unaffected.
	 * `stopTrace(path)` exports the chunk to `path`; `stopTrace()` discards it.
	 */
	startTrace?(): Promise<void>;
	stopTrace?(path?: string): Promise<void>;
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

	/** Reducers see a row click as `click` with a synthetic `row:N` target, so scripts stay readable. */
	async clickRow(nth: number): Promise<void> {
		this.state = this.reducer({ kind: "click", target: `row:${nth}` }, this.state, this.inputs);
	}

	async fill(target: string, value: string): Promise<string> {
		this.inputs[target] = value;
		this.state = this.reducer({ kind: "fill", target, value }, this.state, this.inputs);
		// The landing is the target by construction: snapshot() keys typed values by the same name.
		return target;
	}

	/**
	 * The scripted state, plus whatever has been typed. The typed values ride along as `fields` so a
	 * test exercises an "입력 제한" assertion exactly the way the real browser does: a reducer that
	 * restricts the input simply clears the value, and the assertion then genuinely discriminates.
	 * A reducer may override a field explicitly (that wins) to model the app rejecting the input.
	 */
	async snapshot(): Promise<PageSnapshot> {
		return { ...this.state, fields: { ...this.inputs, ...(this.state.fields ?? {}) } };
	}
}
