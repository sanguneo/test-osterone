/**
 * The runner contract: `runScenario` executes one case (headless page) and
 * returns a `StructuredResult`. Trust invariants enforced here:
 *  - verdict is a deterministic function of cached assertions over the final snapshot;
 *  - any heal event caps the verdict at `needs_review` (never a silent pass);
 *  - a case whose steps were skipped, failed, or aborted did not run as written, so an approved
 *    golden baseline may not lift it to pass — only an AI-repaired case (which did run) may;
 *  - exceptions surface as `error` (excluded from pass/fail statistics upstream).
 * A `FakePage` yields identical deterministic verdict/assertions/confidence across runs.
 */

import type { NormalizedTC } from "../intake/schema.ts";
import {
	type Assertion,
	type AssertionCache,
	type AssertionResult,
	declaredFieldLimit,
	describeAssertion,
	evaluateAssertion,
} from "../interpret/assertion.ts";
import type { AuthoredPlan } from "../interpret/author.ts";
import {
	getOrAuthorAssertions,
	type PageAction,
	parseStep,
	type RequirementCoverage,
	requirementCoverage,
} from "../interpret/interpret.ts";
import { pregroundAction, type RepairRequest, targetOnScreen } from "../interpret/repair.ts";
import type { InterpretationRule } from "../interpret/rule.ts";
import type { BaselineStore } from "../judge/baseline.ts";
import type { Page, PageSnapshot } from "./page.ts";

export type Verdict = "pass" | "fail" | "needs_review" | "error";

export interface RunEnv {
	browser: string;
	viewport: string;
	baseUrl: string;
}

export interface StructuredResult {
	schemaVersion: 1;
	caseId: string;
	executionId: string;
	verdict: Verdict;
	errorInfo?: string;
	confidence: number;
	assertions: AssertionResult[];
	evidenceRefs: string[];
	healEvents: string[];
	timing: { ms: number };
	ruleVersion: number;
	scenarioHash: string;
	attempts: number;
	env: RunEnv;
	snapshot?: PageSnapshot;
	/**
	 * True when an action failed unrecoverably and the remaining actions were skipped. The page is
	 * left wherever the failure happened, so the caller must reset shared state before the next case.
	 */
	aborted?: boolean;
	/**
	 * Did the case carry out the steps it describes? False when a step could not be interpreted, an
	 * action failed, or the tail was abandoned. A `false` here means the final screen was never
	 * driven to the state the case is about, so it must not be signed off with a golden baseline.
	 */
	executedAsWritten?: boolean;
	/**
	 * Why vision disagreed with a deterministic miss, when it did. A model's read of the screenshot
	 * is not a verdict, so this only ever routes the case to a human — it never turns into a pass.
	 */
	visionNote?: string;
	/**
	 * Set when every assertion already held before the case's first interaction. The check cannot tell
	 * whether the action did anything, so the case is held for a human instead of counted as a pass.
	 */
	vacuousNote?: string;
	/**
	 * How much of the written expected result the assertions actually refer to, for cases that list two
	 * or more requirements. `covered < total` means the case passed on a subset of what it promised to
	 * check, so it is held rather than counted as a pass.
	 */
	coverage?: RequirementCoverage;
	/**
	 * True when this `pass` came from a human-approved golden baseline matching, not from the
	 * assertions passing.
	 *
	 * Without it one green case is indistinguishable from another, and the difference matters: an
	 * approval is a judgement a person made once, against the build in front of them at the time. It
	 * keeps producing `pass` for as long as the screen text matches — including after a regression
	 * that leaves that text alone, and including when the screen it blessed was already broken.
	 * "Clear runs" deliberately keeps approvals, so this is the only way to see one at work.
	 */
	baselineLifted?: boolean;
	/** Relative path of the captured Playwright trace chunk (only kept for non-pass verdicts). */
	tracePath?: string;
}

export interface RunOptions {
	page: Page;
	rule: InterpretationRule;
	cache: AssertionCache;
	env: RunEnv;
	/** Deterministic overrides for tests. */
	executionId?: string;
	now?: () => number;
	/** Pre-authored plan (AI author-time). When present, replaces deterministic step parsing + assertions. */
	plan?: AuthoredPlan;
	/**
	 * Actions that reach the starting state the case assumes, from its written 사전조건.
	 *
	 * Kept separate from `plan.actions` on purpose. Preparation is not what the case tests, so it must
	 * not decide the verdict: a preparation that cannot complete holds the case as "precondition
	 * unmet" rather than failing it (the app is not necessarily broken — we could not get to the
	 * screen), and the baseline the discrimination check compares against is taken **after** it, so
	 * opening a popup during setup is not mistaken for the case's own effect.
	 */
	preparation?: PageAction[];
	/** Optional golden-baseline store: an approved match lifts a needs_review to pass; drift keeps it. */
	baseline?: BaselineStore;
	/** Stable env key for baselines (defaults to env.baseUrl, which may be ephemeral). */
	baselineEnv?: string;
	/** When set (and the page supports tracing), capture a per-case trace chunk to this path; kept only if not pass. */
	tracePath?: string;
	/** Vision fallback: when a text assertion fails, judge the screenshot (for visual/image expectations). */
	visionAssert?: (screenshot: string, expected: string) => Promise<boolean>;
	/** Lenient text matching: ignore whitespace/punctuation so near-miss assertions still pass. */
	lenientMatch?: boolean;
	/** Re-check failing assertions for up to this many ms (async content like toasts). 0 = no retry. */
	assertRetryMs?: number;
	/**
	 * How long to wait between reads when settling the pre-interaction screen. 0 (the default) reads
	 * once, which is what a deterministic `FakePage` needs; a live browser wants a real value so the
	 * comparison is not decided by how far an SPA had painted.
	 */
	settleMs?: number;
	/**
	 * In-run AI intervention: given the failed action and the live page, return a grounded
	 * replacement action (or null to give up). Absent = deterministic-only execution.
	 */
	repair?: (req: RepairRequest) => Promise<PageAction | null>;
	/** Max AI repairs per case (default 2 when `repair` is set) — bounds cost and blast radius. */
	repairBudget?: number;
	/** Pause before retrying a recovered action, letting the app settle (default 400ms). */
	recoveryDelayMs?: number;
	/** Budget for an action's *first* attempt (default 1200ms); the post-recovery retry gets the page default. */
	firstTryMs?: number;
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

/** Normalize a URL or path down to its pathname, without trailing slash ("" for the root). */
function pathOf(urlOrPath: string): string {
	const raw = urlOrPath.startsWith("http")
		? URL.canParse(urlOrPath)
			? new URL(urlOrPath).pathname
			: urlOrPath
		: (urlOrPath.split(/[?#]/)[0] ?? urlOrPath);
	return raw.replace(/\/+$/, "");
}

/**
 * Read the page's text once it stops changing, so a comparison against it does not depend on how far
 * a single-page app happened to get with painting.
 *
 * Bounded: two consecutive identical reads win, and after `tries` reads the last one is used
 * regardless. A page that never settles (a spinner, a ticking clock) must not stall the run.
 */
async function settledSnapshot(page: Page, quietMs: number, tries = 3): Promise<PageSnapshot | null> {
	let prev = await page.snapshot({ screenshot: false }).catch(() => null);
	if (quietMs <= 0) return prev;
	for (let i = 1; i < tries && prev; i++) {
		await new Promise((r) => setTimeout(r, quietMs));
		const next = await page.snapshot({ screenshot: false }).catch(() => null);
		if (!next) return prev;
		if (next.text === prev.text) return next;
		prev = next;
	}
	return prev;
}

const AUTH_PATH_RE = /(^|\/)(login|signin|sign-in|auth|logon|sso)(\/|$)/i;

/**
 * Did a navigation actually land where the plan asked? Returns a Korean reason, or null when the
 * landing is acceptable. Deliberately narrow — apps legitimately redirect (`/orders` → `/orders/list`,
 * `/` → anywhere) and flagging those would bury real failures in noise. Only two things count:
 * an error status, and an auth bounce (the app threw us at a login screen we did not ask for),
 * which is exactly the failure that silently invalidates every later step of a run.
 */
export function landingProblem(
	requested: string,
	landing: { url: string; status: number | null } | null | undefined,
): string | null {
	if (!landing) return null;
	if (landing.status !== null && landing.status >= 400) return `HTTP ${landing.status} — 경로가 존재하지 않습니다`;
	const want = pathOf(requested);
	const got = pathOf(landing.url);
	if (!want || want === got || got.startsWith(`${want}/`)) return null;
	if (AUTH_PATH_RE.test(got) && !AUTH_PATH_RE.test(want))
		return `요청 경로 ${want} 대신 로그인 화면(${got})으로 이동됨 — 세션이 없거나 만료되었습니다`;
	return null;
}

function evidenceRef(kind: string, content: string): string {
	// content-addressed relative ref (no absolute local paths)
	let h = 0;
	for (let i = 0; i < content.length; i++) h = (Math.imul(31, h) + content.charCodeAt(i)) | 0;
	return `evidence/${kind}-${(h >>> 0).toString(16)}`;
}

/**
 * Drop the part of a case's plan that merely restates the preparation that just ran.
 *
 * The preparation and the plan are authored from the same case by two independent calls, so the plan
 * routinely opens with the setup all over again. Replaying it is not just wasted work — a `goto` is a
 * reload, and a reload closes whatever the preparation opened. Measured: the precondition "임의 계정
 * 선택된 상태" clicks a row to open the account editor, the plan then said `goto /account` before
 * clicking the 비활성 radio, and the case failed on a control the preparation had put on screen one
 * action earlier. Four more cases in the same run were the same shape, holding on a `fill` into a
 * dialog that had just been navigated away.
 *
 * Narrow by construction:
 *  - both must open with the *same* `goto`, which is the unambiguous signature of a restated setup —
 *    a plan that navigates somewhere else is expressing something the preparation did not;
 *  - only the identical leading run is dropped, so the first action the plan does differently survives;
 *  - never dropped to nothing. A case that performs no action of its own reaches the verdict with no
 *    screen to compare against, and that is the one shape that could pass without exercising anything.
 */
export function withoutRestatedSetup(actions: PageAction[], preparation: readonly PageAction[]): PageAction[] {
	const first = actions[0];
	const prepFirst = preparation[0];
	if (first?.kind !== "goto" || prepFirst?.kind !== "goto" || first.path !== prepFirst.path) return actions;
	let shared = 0;
	while (shared < actions.length && shared < preparation.length) {
		const a = actions[shared];
		const p = preparation[shared];
		if (!a || !p || JSON.stringify(a) !== JSON.stringify(p)) break;
		shared++;
	}
	return shared === 0 || shared === actions.length ? actions : actions.slice(shared);
}

export async function runScenario(tc: NormalizedTC, opts: RunOptions): Promise<StructuredResult> {
	const now = opts.now ?? Date.now;
	const start = now();
	const executionId = opts.executionId ?? `${tc.caseId}-${start}`;
	const healEvents: string[] = [];
	let aborted = false;
	const base = {
		schemaVersion: 1 as const,
		caseId: tc.caseId,
		executionId,
		ruleVersion: opts.rule.ruleVersion,
		scenarioHash: tc.contentHash,
		env: opts.env,
	};

	if (opts.tracePath && opts.page.startTrace) await opts.page.startTrace().catch(() => {});
	let result: StructuredResult;
	try {
		const actions = opts.plan ? opts.plan.actions : tc.steps.map((step) => parseStep(step, opts.rule));
		const assertions = opts.plan ? opts.plan.assertions : getOrAuthorAssertions(tc, opts.rule, opts.cache).assertions;

		const targetOf = (a: PageAction): string =>
			a.kind === "goto"
				? a.path
				: a.kind === "clickRow"
					? `행 #${a.nth}`
					: a.kind === "click" || a.kind === "fill"
						? a.target
						: "";
		/**
		 * `patience` is the per-action budget. The first attempt is deliberately impatient: an element
		 * that is on screen resolves in milliseconds, so a long wait only ever pays off for one that
		 * isn't there — and across a batch that dead waiting dominates the wall clock. The retry after
		 * recovery gets the full budget, because that is where a slow render actually needs it.
		 */
		const perform = async (a: PageAction, patience?: number): Promise<Error | null> => {
			try {
				if (a.kind === "goto") {
					await opts.page.goto(a.path);
					// A navigation that "succeeds" onto the wrong screen is the quietest way to invalidate
					// every later step — verify the landing and fail loudly enough for the recovery ladder.
					const problem = landingProblem(a.path, await opts.page.landing?.());
					if (problem) return new Error(problem);
				} else if (a.kind === "clickRow") {
					// Explicit rather than skipped: a setup step that quietly does nothing is how a case ends
					// up judged on the wrong screen.
					if (!opts.page.clickRow) return new Error("이 페이지 구현은 목록 행 선택을 지원하지 않습니다");
					await opts.page.clickRow(a.nth, patience);
				} else if (a.kind === "click") await opts.page.click(a.target, patience);
				else if (a.kind === "fill") await opts.page.fill(a.target, a.value, patience);
				return null;
			} catch (err) {
				return err as Error;
			}
		};
		let repairsLeft = opts.repair ? (opts.repairBudget ?? 2) : 0;
		/**
		 * Did the case actually carry out the steps it describes?
		 *
		 * A heal event alone does not answer that: an AI repair means the case *did* run (one action
		 * was re-grounded on the live screen and the rest continued), while a skipped step, a failed
		 * action, or an abort means it did not. Only the first kind may later be lifted to pass by an
		 * approved baseline — a screen that matches the golden image proves nothing about a case that
		 * never touched it.
		 */
		let executedAsWritten = true;
		/**
		 * The screens this case actually passed through, in order, after each successful action.
		 *
		 * The engine used to judge one moment: the final snapshot. Anything that appeared and left was
		 * therefore unverifiable — 93 of this sheet's 652 cases say "팝업/스낵바가 표출되어야 한다", and a
		 * toast is gone long before the run ends. Worse, the retry window already found such a toast and
		 * then the final re-evaluation threw the result away, so `assertRetryMs` only ever helped
		 * content that appears *and stays*.
		 *
		 * Their mirror image needs the same timeline: 93 more cases say "종료되어야 한다", which is
		 * structurally true before the case begins too (the popup was not open yet). Judged on the final
		 * screen alone that check can never discriminate. Judged across the timeline — appeared, then
		 * gone — it can.
		 *
		 * Text only: this is read by assertions, never persisted, and keeping every screen's HTML for a
		 * long case would cost far more than it is worth.
		 */
		const observed: PageSnapshot[] = [];
		/**
		 * Set when vision read the screenshot and disagreed with a deterministic miss. Carries the
		 * reason to the review card; it can only soften `fail` to `needs_review`, never produce a pass.
		 */
		let visionNote: string | undefined;
		/**
		 * The screen as it looked immediately before the case's first interaction, and a note set when
		 * the assertions turn out not to distinguish it from the final screen.
		 *
		 * An assertion that already held before the case clicked anything proves nothing about the
		 * click. Measured on a live sheet: "개인정보처리방침 선택 → 팝업 표출되어야 한다" was checked with
		 * `textIncludes: 개인정보처리방침` — the text of the link being clicked. The popup never opened
		 * (the human's recorded defect) and the case passed anyway, because the assertion was testing
		 * the trigger instead of the outcome.
		 *
		 * The baseline must be a *settled* screen. Taken naively it is whatever had rendered by the
		 * time the click fired, which made the check disagree with itself: two live cases of identical
		 * shape (same filter, same six labels, same assertions) split — one held as non-discriminating,
		 * the other passed — purely because one SPA had painted its options and the other had not.
		 * A verdict that depends on paint timing is the one thing this engine may not have.
		 */
		let preInteraction: PageSnapshot | null = null;
		let vacuousNote: string | undefined;

		/** The screen as last read, so grounding an action costs no extra round trip. */
		let lastSeen: PageSnapshot | null = null;

		/**
		 * Reach the state the case assumes before running any of its own steps.
		 *
		 * Measured: of 57 cases in a 98-case run the engine could not drive, all 57 had a precondition
		 * written in the sheet that the engine had never read. Without it the model rediscovered the
		 * setup through the repair path — 28 times in that one run, one model round trip each — and
		 * every recovery was a heal event that capped the case at `needs_review`.
		 *
		 * A preparation that cannot complete is not a verdict about the app: we never reached the
		 * screen the case describes, so nothing about the case was tested. It holds, and it leaves
		 * `executedAsWritten` false so no approved baseline can sign it off either.
		 */
		let preparationFailure: string | undefined;
		for (const prep of opts.preparation ?? []) {
			if (prep.kind === "verify" || prep.kind === "unknown") continue;
			// Full patience on the retry: setup is not the thing under test, and a slow popup is not a
			// finding about the app.
			const err = (await perform(prep, opts.firstTryMs ?? 1200)) ? await perform(prep) : null;
			if (err) {
				preparationFailure = `${prep.kind}: ${targetOf(prep)} — ${err.message.split("\n")[0] ?? "실패"}`;
				executedAsWritten = false;
				healEvents.push(`precondition: ${preparationFailure}`);
				break;
			}
			lastSeen = await opts.page.snapshot({ screenshot: false }).catch(() => null);
		}
		// A case whose starting state was never reached must not run its own steps: performing them
		// against the wrong screen manufactures evidence about something that was never exercised.
		const actionsToRun = preparationFailure ? [] : withoutRestatedSetup(actions, opts.preparation ?? []);
		for (let i = 0; i < actionsToRun.length; i++) {
			let action = actionsToRun[i];
			if (!action) continue;
			// `verify` is covered by assertions; `unknown` is a step the rule could not interpret —
			// record it (capping the verdict) instead of silently pretending the case ran in full.
			if (action.kind === "verify") continue;
			if (action.kind === "unknown") {
				healEvents.push(
					`skip: ${action.text.replace(/\s+/g, " ").slice(0, 80)} — 해석하지 못한 스텝이라 실행하지 않았습니다`,
				);
				executedAsWritten = false;
				continue;
			}

			// Record the screen the first interaction is about to act on. Settled, not instantaneous —
			// see `preInteraction`.
			if (!preInteraction && (action.kind === "click" || action.kind === "fill" || action.kind === "clickRow")) {
				preInteraction = await settledSnapshot(opts.page, opts.settleMs ?? 0);
				lastSeen = preInteraction;
			}
			// Snap a drifted label onto the one the page actually carries, before spending a locator
			// timeout and a model call on discovering the drift.
			if (lastSeen) {
				const g = pregroundAction(action, lastSeen.html, lastSeen.url);
				if (g) {
					// Spacing-only drift is a normalization, not a different element: no heal event, so a
					// case whose only problem was a stray space can pass instead of being held forever.
					// A partial match is a guess about which control was meant — that stays visible.
					if (!g.normalizedOnly) {
						healEvents.push(`ground: ${targetOf(action)} — 화면의 라벨 '${targetOf(g.action)}'로 맞췄습니다`);
					}
					action = g.action;
				}
			}
			/**
			 * Is a later click/fill still coming? Only then may a navigation reset the baseline — if the
			 * *last* interaction is what navigated, the navigation is the outcome the case is about, and
			 * throwing the baseline away would make every assertion look like it "already held".
			 */
			const moreInteractionsAfter = actionsToRun
				.slice(i + 1)
				.some((a) => a?.kind === "click" || a?.kind === "fill" || a?.kind === "clickRow");
			let err = await perform(action, opts.firstTryMs ?? 1200);
			// The live screen at the moment of failure — reused for the presence check and the repair,
			// so a miss costs one cheap DOM read instead of a second full locator timeout.
			let live = err ? await opts.page.snapshot({ screenshot: false }).catch(() => null) : null;
			if (err && (!live || targetOnScreen(action, live.html, live.url))) {
				// 1. Deterministic recovery: the target *is* on screen, so it is blocked or still
				// settling — clear whatever intercepts input and give it the full budget this time.
				if (opts.page.dismissOverlays) {
					await opts.page.dismissOverlays(targetOf(action)).catch(() => {});
					await new Promise((r) => setTimeout(r, opts.recoveryDelayMs ?? 400));
				}
				err = await perform(action);
				if (err) live = await opts.page.snapshot({ screenshot: false }).catch(() => null);
			}
			if (err && opts.repair && repairsLeft > 0) {
				// 2. AI intervention: re-read the live screen and act on what is actually there. The
				// screenshot is worth its cost here — a blocking dialog is visible long before the DOM
				// scan explains it — so this is the one place that pays for a full snapshot on failure.
				repairsLeft--;
				const shot = await opts.page.snapshot().catch(() => null);
				const seen = shot ?? live;
				const fixed = seen
					? await opts
							.repair({
								action,
								error: err.message,
								html: seen.html,
								url: seen.url,
								screenshot: seen.screenshot,
								title: tc.title,
								steps: tc.steps,
								expected: tc.expected,
							})
							.catch(() => null)
					: null;
				if (fixed) {
					const repairErr = await perform(fixed);
					if (!repairErr) {
						// Repaired, not hidden: still a heal event, so the verdict stays capped at needs_review.
						healEvents.push(
							`repair: ${targetOf(action)} — AI가 화면을 다시 읽고 '${targetOf(fixed)}'(${fixed.kind})로 교정해 진행했습니다`,
						);
						continue;
					}
					err = repairErr;
				}
			}
			if (err) {
				// 3. Unrecoverable: the page is no longer where the plan thinks it is. Stop the case —
				// running the tail would act on the wrong screen (and can fire destructive clicks).
				healEvents.push(`${action.kind}: ${targetOf(action)} — ${err.message}`);
				// Everything still to do that would actually touch the page.
				const remaining = actions.slice(i + 1).filter((a) => a.kind !== "verify" && a.kind !== "unknown").length;
				if (remaining > 0)
					healEvents.push(`abort: 남은 동작 ${remaining}개 — 선행 스텝 실패로 화면 상태를 신뢰할 수 없어 중단했습니다`);
				executedAsWritten = false;
				aborted = true;
				break;
			}
			// A toast raised by *this* action is gone long before the case ends, so record the screen at
			// every action boundary rather than only after the last one. One text read per action.
			const afterAction = await opts.page.snapshot({ screenshot: false }).catch(() => null);
			if (afterAction) observed.push(afterAction);
			// The screen after this action is the screen the next one acts on — reuse it for grounding
			// rather than paying for another read.
			if (afterAction) lastSeen = afterAction;
			// This interaction navigated and the case has more to do, so it was getting to the screen,
			// not exercising it. Rebase the baseline: measured on the live app, a menu click to 기관 관리
			// left the baseline on 계정 관리 — a different page carrying the *same* six filter labels —
			// so the real filter click looked like it revealed nothing. The identical case that was
			// already on its page passed. Same shape, opposite verdicts, decided by a nav step.
			if (preInteraction && moreInteractionsAfter && afterAction && afterAction.url !== preInteraction.url) {
				preInteraction = await settledSnapshot(opts.page, opts.settleMs ?? 0);
			}
		}

		// Cheap first: the retry loop only needs DOM text/url, and the PNG is most of a snapshot's cost.
		let snap = await opts.page.snapshot({ screenshot: false });
		observed.push(snap);
		let results = assertions.map((a) => evaluateAssertion(a, snap, { lenient: opts.lenientMatch }));
		// Async content (toasts, late-rendered lists) can appear just after the last action — if an
		// assertion misses, re-snapshot briefly before giving up. Passing-all cases skip this.
		if (assertions.length > 0 && opts.assertRetryMs) {
			const deadline = Date.now() + opts.assertRetryMs;
			while (results.some((r) => !r.passed) && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 400));
				snap = await opts.page.snapshot({ screenshot: false });
				observed.push(snap);
				results = assertions.map((a) => evaluateAssertion(a, snap, { lenient: opts.lenientMatch }));
			}
		}
		// Evidence (and the vision fallback) needs the image: take exactly one full snapshot of the
		// final state and judge on it, so the verdict and the screenshot always describe one moment.
		snap = await opts.page.snapshot();
		results = assertions.map((a) => evaluateAssertion(a, snap, { lenient: opts.lenientMatch }));
		/**
		 * The final screen decides absence; presence may be satisfied by any screen the case passed
		 * through. `textIncludes` says "this must appear", and it did appear — that the run went on to
		 * dismiss the toast is not the app's failure. `textNotIncludes` and `urlIncludes` keep judging
		 * the end state, which is the whole point of "종료되어야 한다": matching any moment would pass
		 * those the instant the popup showed.
		 */
		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			if (!r || r.passed || r.assertion.kind !== "textIncludes") continue;
			const seen = observed.find((s) => evaluateAssertion(r.assertion, s, { lenient: opts.lenientMatch }).passed);
			if (seen) {
				results[i] = { ...r, passed: true, detail: `${r.detail} · 실행 중 화면에서 확인됨(최종 화면에는 없음)` };
			}
		}
		if (opts.visionAssert && snap.screenshot) {
			/**
			 * Vision reads the screenshot when the DOM text could not confirm the expectation. What it
			 * returns is a model's opinion, so it routes the case to a human — it never decides the
			 * verdict.
			 *
			 * It used to flip a failed `textIncludes` straight to `passed: true`. Measured on a live
			 * sheet, that turned five cases a human had marked Fail into `pass`, with details reading
			 * `text lacks "dxsupport@aegisep.com" · 비전 확인` — the text genuinely was not there and
			 * vision waved it through. That inverts the whole trust model: the engine judges
			 * deterministically, the model only writes and repairs.
			 *
			 * So the assertion keeps its deterministic result and the disagreement is recorded. Below,
			 * a dispute caps the verdict at `needs_review` instead of `fail`: the engine says no, the
			 * screen says maybe, and that is precisely a case for a human. Once the human approves the
			 * screen as a golden baseline, later runs pass deterministically — the sanctioned route for
			 * a purely visual expectation to go green.
			 */
			for (let i = 0; i < results.length; i++) {
				const r = results[i];
				if (r && !r.passed && r.assertion.kind === "textIncludes") {
					const ok = await opts.visionAssert(snap.screenshot, String(r.assertion.value ?? "")).catch(() => false);
					if (ok) {
						results[i] = { ...r, detail: `${r.detail} · 비전 판단: 화면상 충족(사람 확인 필요)` };
						visionNote = `텍스트로는 확인되지 않았지만 화면상으로는 충족해 보입니다 — 사람 확인이 필요합니다: ${String(
							r.assertion.value ?? "",
						)
							.replace(/\s+/g, " ")
							.slice(0, 60)}`;
					}
				}
			}
			if (results.length === 0 && tc.expected.trim()) {
				// A purely visual expectation with no checkable text assertion. The case is already
				// heading for review (no assertions); vision only explains why a human should look.
				const ok = await opts.visionAssert(snap.screenshot, tc.expected).catch(() => false);
				if (ok)
					visionNote = `검증 가능한 텍스트 assertion이 없습니다. 화면상으로는 기대와 일치해 보입니다 — 사람 확인이 필요합니다: ${tc.expected
						.replace(/\s+/g, " ")
						.slice(0, 60)}`;
			}
		}
		const evidenceRefs = [evidenceRef("dom", snap.html), evidenceRef("url", snap.url)];
		const passRatio = results.length > 0 ? results.filter((r) => r.passed).length / results.length : 0;

		let verdict: Verdict;
		let confidence: number;
		if (healEvents.length > 0) {
			verdict = "needs_review";
			confidence = round2(passRatio * 0.5);
		} else if (results.length === 0) {
			verdict = "needs_review";
			confidence = 0;
		} else if (passRatio === 1) {
			verdict = "pass";
			confidence = 1;
		} else {
			verdict = "fail";
			confidence = round2(1 - passRatio);
		}
		// The engine says the text is not there, the screenshot says it looks satisfied. That is
		// ambiguity, not a verdict — hand it to a human instead of blaming the app. Never the other
		// direction: a dispute can only soften `fail`, never lift anything to `pass`.
		if (verdict === "fail" && visionNote) {
			verdict = "needs_review";
			confidence = round2(passRatio * 0.5);
		}
		/**
		 * A field assertion is exempt from both gates below, and for the same reason each time.
		 *
		 * `fieldAtMost` / `fieldExcludes` check that the app *refused* what the case typed. A working
		 * restriction changes nothing, so "did anything the assertions talk about change?" answers no —
		 * and the limit is stated in the step, not the expectation, so "does an assertion quote the
		 * requirement?" also answers no. Both gates exist to catch checks that cannot tell whether the app
		 * did its job; these tell exactly that, by reading the field's own value. Unlike the string check
		 * that had to be reverted, they cannot be satisfied by a field that was never found: an
		 * unresolvable field fails.
		 *
		 * The exemption ends where its premise does. When the box itself declares `maxlength` at or below
		 * the asserted limit, the value was never free to be anything else — `fill` cannot put 260
		 * characters into a control that declares 255 — so reading it back proves nothing about the app,
		 * and the gates are exactly right to hold it. Measured on NO 142: the field held 255 of the 260
		 * typed, the check called the limit working, and the defect a human recorded for that very box is
		 * that it is not. A pass nobody earned is the one outcome this engine may not produce.
		 */
		const decidedByTheBrowser = (a: Assertion): boolean => {
			if (a.kind !== "fieldAtMost") return false;
			const declared = declaredFieldLimit(snap, a.field);
			return declared !== null && declared <= a.max;
		};
		const checksField = results.some(
			(r) =>
				(r.assertion.kind === "fieldAtMost" || r.assertion.kind === "fieldExcludes") &&
				!decidedByTheBrowser(r.assertion),
		);
		/**
		 * Did anything the assertions talk about actually change during the case?
		 *
		 * A check whose answer is the same on every screen the case passed through — before the first
		 * click, in between, and at the end — cannot tell whether the app did what the case describes.
		 * Two live shapes land here: asserting the text of the very link being clicked (the popup never
		 * opened and the case passed anyway), and asserting filter labels that were already on screen.
		 *
		 * The timeline, not just the pre/post pair, is what makes this usable for transient UI. A toast
		 * that appeared and left changed twice, so both "표출되어야 한다" and its mirror "종료되어야 한다"
		 * are informative — where a pre-versus-final comparison alone would call the second one vacuous
		 * every time, since the popup was equally absent before the case started.
		 *
		 * Not a `fail`: the app may be fine and the check merely too weak. Hand it to a human.
		 */
		if (verdict === "pass" && preInteraction && !checksField) {
			const pre = preInteraction;
			/** Is the assertion's subject on this screen, regardless of which way the assertion reads? */
			const present = (a: Assertion, s: PageSnapshot): boolean =>
				evaluateAssertion(a.kind === "textNotIncludes" ? { kind: "textIncludes", value: a.value } : a, s, {
					lenient: opts.lenientMatch,
				}).passed;
			const informative = results.some((r) => {
				const truth = (s: PageSnapshot) => evaluateAssertion(r.assertion, s, { lenient: opts.lenientMatch }).passed;
				// The end state answers differently than the start: the case changed something.
				if (truth(pre) !== truth(snap)) return true;
				// Or the subject appeared and left. That is the only reason to look at the middle at all:
				// "팝업이 종료되어야 한다" reads the same before the case and after it, and only the
				// appearance in between separates a working close from a popup that never opened.
				//
				// One direction only — absent at both ends, present in between. The mirror shape
				// (present, gone, present again) is re-render flicker, never an intended outcome, and
				// counting it is how an always-visible filter label was called informative and passed.
				return (
					!present(r.assertion, pre) && !present(r.assertion, snap) && observed.some((s) => present(r.assertion, s))
				);
			});
			if (!informative) {
				verdict = "needs_review";
				confidence = 0.5;
				vacuousNote = `동작 전 화면에서도 모든 검증이 통과합니다 — 이 검증은 동작이 실제로 무엇을 바꿨는지 구분하지 못합니다: ${results
					.map((r) => describeAssertion(r.assertion))
					.join(", ")
					.replace(/\s+/g, " ")
					.slice(0, 80)}`;
			}
		}
		/**
		 * Do the assertions actually speak to what the case says should happen?
		 *
		 * With several written outcomes, passing on a subset is how a case goes green while the very
		 * thing a human later reports as broken was never tested. With a single outcome the question is
		 * narrower and sharper — is *anything* here about that outcome? Two measured false passes were
		 * exactly that: "새비밀번호 12자 초과 → 입력 제한되어야 한다" passed on the email field's hint text,
		 * and "하단 문구가 붉은색으로 표시되어야 한다" passed on the hint's content, colour being something
		 * no text assertion can read. Nothing was attributable to the requirement in either.
		 *
		 * So: several outcomes must be covered fully, a single outcome must be covered at all. Either
		 * way it holds rather than fails — the app may be fine and the check merely beside the point.
		 */
		const coverage = requirementCoverage(tc.expected, assertions) ?? undefined;
		const underChecked = coverage
			? coverage.total > 1
				? coverage.covered < coverage.total
				: coverage.covered === 0
			: false;
		if (verdict === "pass" && coverage && underChecked && !checksField) {
			verdict = "needs_review";
			confidence = round2(coverage.covered / coverage.total);
		}

		// A golden baseline substitutes for an assertion we could not author — it does not substitute
		// for running the case. Lifting a review whose cause was a skipped/failed/aborted step would
		// pass a case that never exercised the app: on a prose sheet with no model connected, rule
		// interpretation executes nothing, the browser sits on the landing screen, and any baseline
		// approved for that screen turns the whole sheet green.
		let baselineLifted = false;
		if (verdict === "needs_review" && executedAsWritten && opts.baseline) {
			const env = opts.baselineEnv ?? opts.env.baseUrl;
			// gate() proposes a pending baseline on first sight; an approved + masked match lifts to pass.
			if (opts.baseline.gate(tc.caseId, opts.rule.ruleVersion, env, snap.text).status === "match") {
				verdict = "pass";
				confidence = 0.9;
				baselineLifted = true;
			}
		}

		result = {
			...base,
			verdict,
			confidence,
			assertions: results,
			evidenceRefs,
			healEvents,
			timing: { ms: now() - start },
			attempts: 1,
			snapshot: snap,
			executedAsWritten,
			...(visionNote ? { visionNote } : {}),
			...(vacuousNote ? { vacuousNote } : {}),
			...(coverage ? { coverage } : {}),
			...(baselineLifted ? { baselineLifted: true } : {}),
			...(aborted ? { aborted: true } : {}),
		};
	} catch (err) {
		result = {
			...base,
			verdict: "error",
			errorInfo: (err as Error).message,
			confidence: 0,
			assertions: [],
			evidenceRefs: [],
			healEvents,
			timing: { ms: now() - start },
			attempts: 1,
			// An exception means the case never reached a judged state at all.
			executedAsWritten: false,
			...(aborted ? { aborted: true } : {}),
		};
	}
	if (opts.tracePath && opts.page.stopTrace) {
		// Keep the trace only when there is something to review (never for a clean pass).
		const keep = result.verdict !== "pass";
		await opts.page.stopTrace(keep ? opts.tracePath : undefined).catch(() => {});
		if (keep) result.tracePath = opts.tracePath;
	}
	return result;
}

/** The deterministic slice of a result used for rerun-determinism checks. */
export function determinismView(
	r: StructuredResult,
): Pick<StructuredResult, "verdict" | "confidence" | "assertions" | "healEvents" | "ruleVersion" | "scenarioHash"> {
	return {
		verdict: r.verdict,
		confidence: r.confidence,
		assertions: r.assertions,
		healEvents: r.healEvents,
		ruleVersion: r.ruleVersion,
		scenarioHash: r.scenarioHash,
	};
}
