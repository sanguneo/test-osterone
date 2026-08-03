/**
 * Small pure helpers for the studio run loop, extracted so they can be unit-tested
 * without importing `server.ts` (which starts the HTTP server as a side effect on import).
 */

/**
 * Login/auth feature keywords — a case that must meet a real login form. Password/ID recovery
 * counts: those screens are reachable only while signed out. Tight on purpose: `인증(?!서)` keeps
 * "인증서 등록" out, and `\bauth\b` keeps "author"/"authoring" out.
 */
const LOGIN_RE =
	/로그인|log\s?in|sign\s?in|인증(?!서)|\bauth(?:entication)?\b|\bsso\b|(?:아이디|비밀번호|계정)\s*\/?\s*(?:비밀번호)?\s*찾기|비밀번호\s*재설정|password\s*reset|forgot/i;
/** Sign-out feature keywords — a case that deliberately ends the session. */
const LOGOUT_RE = /로그아웃|log\s?out|sign\s?out|세션\s?종료/i;

/**
 * Text that classifies a case. Both the category and the title count: a spreadsheet tab is often
 * the *file's* name ("TestCase_샘플관리 시스템_관리자") while the feature lives in the title
 * column ("로그인"), so reading only the category would classify a whole login suite as ordinary.
 */
function caseLabel(tc: { category?: string | null; title?: string | null }): string {
	return `${tc.category ?? ""} ${tc.title ?? ""}`;
}

/**
 * A case that must begin from a **signed-out** browser: it tests the login/auth feature itself.
 * Cases share one browser session, so without an explicit sign-out the second login case never
 * meets a login form at all — it silently exercises the app's home screen instead. This is also why
 * sign-in is lazy: verifying the login page must never be preceded by a login.
 */
export function startsSignedOut(tc: { category?: string | null; title?: string | null }): boolean {
	return LOGIN_RE.test(caseLabel(tc));
}

/**
 * A case that **ends** signed out: it logs out on purpose. The session it leaves behind is dead, so
 * the next case has to sign back in rather than inherit it.
 */
export function endsSignedOut(tc: { category?: string | null; title?: string | null }): boolean {
	return LOGOUT_RE.test(caseLabel(tc));
}

/** What the runner must do to the browser session before a case can be trusted to run. */
export type AuthStep =
	| { kind: "none" }
	/** Clear cookies + storage: the case tests the login flow and needs a real login form. */
	| { kind: "signOut" }
	/** Authenticate as this account: nobody is signed in, or the wrong user is. */
	| { kind: "signIn"; accountId: string };

export interface SessionState {
	/** Account id the browser is currently authenticated as (null = signed out or unknown). */
	signedInAs: string | null;
	/** Consecutive sign-in failures since the last success; a success resets it. */
	failedSignIns: number;
	/**
	 * The app *said no* — a wrong-credentials message on screen. Permanent for the batch: resubmitting
	 * a refused credential buys nothing but a locked account. Distinct from `failedSignIns`, which
	 * counts silent/transient failures — a login that merely errored tonight is not a refusal, and the
	 * old breaker treated it as one: two transient goto failures opened it permanently and the
	 * remaining 66 cases of a 98-case batch ran signed out, every one held as precondition unmet.
	 */
	credentialRefused?: boolean;
	/** Cases seen since the last sign-in attempt — the half-open window's clock. */
	casesSinceAttempt?: number;
}

export interface AuthPlanOptions {
	/** Sample run: no real app, no credentials — never touch the session. */
	sample?: boolean;
	/** Consecutive failures before attempts pause (default 2) instead of burning a timeout per case. */
	maxFailedSignIns?: number;
	/** While paused, try again after this many cases (default 5) — the app may just have been slow. */
	retryAfterCases?: number;
}

/**
 * The session contract for one case, as a pure decision so it can be tested as a sequence.
 *
 * Role routing is meaningless unless the browser is actually *that* user: handing a case's
 * credentials to the plan author (so it can type them) is not authentication. Equally, a login
 * case that inherits the batch's session never sees a login form. Hence: auth-feature cases always
 * start from a cleared session; every other case is signed in as the account its `role` resolved to,
 * switching users when the live session belongs to somebody else.
 */
export function authStepFor(
	tc: { category?: string | null; title?: string | null },
	account: { id: string; username?: string; password?: string } | undefined,
	state: SessionState,
	opts: AuthPlanOptions = {},
): AuthStep {
	if (opts.sample) return { kind: "none" };
	// Always clear, even when we believe we are signed out: a previous login case may have
	// authenticated through its own steps, leaving cookies this runner never recorded.
	if (startsSignedOut(tc)) return { kind: "signOut" };
	if (!account || !(account.username || account.password)) return { kind: "none" };
	if (state.signedInAs === account.id) return { kind: "none" };
	// The app explicitly refused these credentials: never resubmit them, for the rest of the batch.
	if (state.credentialRefused) return { kind: "none" };
	// Silent/transient failures pause the attempts rather than end them: after the budget, sit out a
	// few cases, then half-open — one fresh attempt. A success closes the breaker (the caller resets
	// the counter); another failure re-arms the pause. The alternative is what actually happened: two
	// transient failures tripped the old permanent breaker and 66 signed-out cases were held unmet.
	if (state.failedSignIns >= (opts.maxFailedSignIns ?? 2)) {
		if ((state.casesSinceAttempt ?? 0) < (opts.retryAfterCases ?? 5)) return { kind: "none" };
	}
	return { kind: "signIn", accountId: account.id };
}

/** What a finished run tells the next one about which cases touched the app's data. */
export interface WriteLedger {
	/** Cases observed sending a POST/PUT/PATCH/DELETE. */
	wrote: Set<string>;
	/** Cases the ledger has any observation for. Absence is not innocence — see `partitionForParallel`. */
	known: Set<string>;
}

/** Read the ledger a previous run left behind. */
export function writeLedger(results: readonly { caseId: string; wroteToApp?: boolean }[]): WriteLedger {
	const wrote = new Set<string>();
	const known = new Set<string>();
	for (const r of results) {
		known.add(r.caseId);
		if (r.wroteToApp) wrote.add(r.caseId);
	}
	return { wrote, known };
}

/**
 * Split a sheet into what may share the app and what may not.
 *
 * Two cases can run at the same time when neither changes what the other reads. Everything local is
 * already private — each lane owns a browser context, so a filled box or an open dialog belongs to
 * whoever did it — which leaves the app's own data, and the only honest evidence about that is
 * whether the app was asked to change it. A previous run recorded exactly that, per case.
 *
 * Three ways to stay serial, and all of them fail closed:
 *
 *  - **The ledger says it wrote.** It edits what someone else is reading.
 *  - **The ledger has never seen it.** A case added since the last run, or a first run on a new sheet.
 *    Absence of evidence is not evidence: it runs alone, and earns its place next time.
 *  - **It owns the session.** A login case starts signed out and a logout case ends signed in as
 *    nobody. Lanes each hold their own cookies, but these cases are *about* the session, and running
 *    them beside anything turns the run into a statement about timing rather than about the app.
 *
 * Sheet order is preserved inside both halves, so a run still reads the way the sheet does.
 */
export function partitionForParallel(
	cases: readonly { caseId: string; title?: string | null; category?: string | null }[],
	ledger: WriteLedger,
): { parallel: string[]; serial: string[] } {
	const parallel: string[] = [];
	const serial: string[] = [];
	for (const tc of cases) {
		const ownsSession = startsSignedOut(tc) || endsSignedOut(tc);
		const unproven = !ledger.known.has(tc.caseId) || ledger.wrote.has(tc.caseId);
		(ownsSession || unproven ? serial : parallel).push(tc.caseId);
	}
	return { parallel, serial };
}

/** Default number of per-case traces a sheet keeps on disk. */
export const TRACE_KEEP_LIMIT = 60;

/**
 * Which trace files to drop so a sheet keeps only its newest `limit`.
 *
 * A trace is ~5MB and every non-pass case keeps one, so a single 640-case sweep wrote 2.3GB and
 * filled the disk. Reviewers work from the newest run and the review queue is rebuilt on every run,
 * so older zips are orphaned evidence nothing in the UI can reach.
 */
export function tracesToEvict(files: readonly { path: string; mtimeMs: number }[], limit = TRACE_KEEP_LIMIT): string[] {
	if (files.length <= limit) return [];
	return [...files]
		.sort((a, b) => b.mtimeMs - a.mtimeMs)
		.slice(limit)
		.map((f) => f.path);
}

/** Temp-dir prefixes Playwright uses for trace buffering (screencast frames + captured resources). */
const PLAYWRIGHT_TRACE_TEMP = ["playwright-artifacts-", "playwright-tracing-"];

/**
 * Stale Playwright trace scratch directories to delete.
 *
 * Tracing buffers every screencast frame and captured resource in a temp dir for the whole
 * *context* lifetime — one long sweep left a single 13GB directory behind. Playwright removes it
 * when the context closes, so anything still there long after the fact belongs to a run that was
 * killed. Browser profile dirs are deliberately not touched: they are tiny and may still be live.
 */
export function stalePlaywrightTempDirs(
	entries: readonly { name: string; mtimeMs: number }[],
	now: number,
	maxAgeMs = 2 * 60 * 60 * 1000,
): string[] {
	return entries
		.filter((e) => PLAYWRIGHT_TRACE_TEMP.some((p) => e.name.startsWith(p)) && now - e.mtimeMs > maxAgeMs)
		.map((e) => e.name);
}

/**
 * Parse a heal event string (`"<kind>: <target> — <playwright error>"`) into the action
 * kind and the element it targeted, for a precise, human-readable review reason.
 */
export function parseHealEvent(healEvent: string): { kind: string; target: string } {
	const m = /^([^:]+):\s*(.*?)\s*(?:—|$)/.exec(healEvent ?? "");
	return { kind: (m?.[1] ?? "").trim(), target: (m?.[2] ?? "").trim() };
}

/**
 * Turn a case's heal events into the single review reason that best explains why a human is
 * needed. Severity order: a precondition that could not be reached (the case never got to the screen
 * it describes, so nothing about it was tested), then an action that could not be performed at all,
 * then an AI repair the human should confirm, then a label the engine snapped onto the screen's own
 * wording, then a step the rule could not interpret. Without this the first event wins by accident
 * and the review panel explains the wrong thing.
 *
 * Every kind that can be recorded needs a case here. A label snap used to fall through to the
 * catch-all below, so the panel told the reviewer the element "could not be found and the action was
 * skipped" about a case whose action had run and whose typed value had verified — the reader's whole
 * picture of the run was upside down.
 */
export function summarizeHeal(healEvents: readonly string[]): { reason: string; target: string } {
	const parsed = healEvents.map(parseHealEvent);
	// First, because it changes what the reviewer does: fix the setup or the sheet, not the app.
	const unmet = parsed.find((h) => h.kind === "precondition");
	if (unmet) return { reason: "precondition unmet", target: unmet.target };
	const failed = parsed.find((h) => h.kind === "goto" || h.kind === "click" || h.kind === "fill");
	if (failed) return { reason: `self-heal: ${failed.kind}`, target: failed.target };
	const repaired = parsed.find((h) => h.kind === "repair");
	if (repaired) return { reason: "ai repair", target: repaired.target };
	const skipped = parsed.find((h) => h.kind === "skip");
	if (skipped) return { reason: "step not interpreted", target: skipped.target };
	const snapped = parsed.find((h) => h.kind === "ground");
	if (snapped) return { reason: "label snapped", target: snapped.target };
	return { reason: "self-heal: action", target: parsed[0]?.target ?? "" };
}

/** Which model drove a run, stamped on the run record itself. */
export interface RunModelMeta {
	/** Model that authored the plans and judged screenshots. Absent on rule-interpreted runs. */
	model?: string;
	/** Reasoning effort the connection pinned. Absent when the model's own default was used. */
	reasoning?: string;
}

/**
 * Resolve the model attribution for a finished run.
 *
 * A run's history entry used to carry only pass/fail counts, so two runs of the same sheet were
 * indistinguishable — there was no way to tell afterwards which model or reasoning level produced
 * which verdicts, which is exactly what comparing them requires. Rule-interpreted runs record no
 * model on purpose: no model took part, and attributing one would make a rule run look like a
 * model result in any later comparison.
 */
export function runModelMeta(
	interpreter: "ai" | "rule",
	auth: { model?: string; reasoning?: string } | null | undefined,
): RunModelMeta {
	if (interpreter !== "ai" || !auth) return {};
	const meta: RunModelMeta = {};
	const model = auth.model?.trim();
	const reasoning = auth.reasoning?.trim();
	if (model) meta.model = model;
	if (reasoning) meta.reasoning = reasoning;
	return meta;
}
/** Show the cursor again and reset SGR attributes. Idempotent — safe to write on every exit path. */
export const TERMINAL_RESTORE_SEQ = "\u001b[?25h\u001b[0m";

/** The pieces of the process `restoreTerminal` touches, injectable so the behavior is testable. */
export interface TerminalIo {
	stdin: { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
	stdout: { isTTY?: boolean };
	stderr: { isTTY?: boolean };
	/** Must be a *synchronous* write — see `restoreTerminal`. */
	writeSync: (fd: number, text: string) => void;
}

/**
 * Put the terminal back the way we found it.
 *
 * Two things break it and neither is our own doing: a Chromium child inherits this console and can
 * leave its input mode changed (echo off), and an abrupt Ctrl+C can cut us off with the cursor
 * hidden mid-render. Both outlive the process, so the shell stays broken until the user runs
 * `reset`.
 *
 * `setRawMode(false)` runs even though we never enable raw mode: on Windows libuv resets
 * `ENABLE_ECHO_INPUT`/`ENABLE_LINE_INPUT` on the console handle there, which is exactly the repair
 * for a child that turned echo off.
 *
 * The write must be synchronous. Node's TTY writes are **asynchronous on Windows**, so a
 * `process.stdout.write` issued from a signal or `exit` handler is queued and then discarded when
 * the process exits — the sequence never reaches the terminal, which is why the cursor kept
 * coming back hidden after shutdown.
 *
 * Every step is guarded: during exit a handle can already be closed, and throwing here would turn
 * a clean shutdown into a crash.
 */
export function restoreTerminal(io: TerminalIo): void {
	try {
		if (io.stdin.isTTY && typeof io.stdin.setRawMode === "function") io.stdin.setRawMode(false);
	} catch {}
	// Prefer stdout, but honour a run whose stdout is redirected to a file while stderr is the console.
	const fd = io.stdout.isTTY ? 1 : io.stderr.isTTY ? 2 : null;
	if (fd === null) return;
	try {
		io.writeSync(fd, TERMINAL_RESTORE_SEQ);
	} catch {}
}
