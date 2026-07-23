/**
 * The runner contract: `runScenario` executes one case (headless page) and
 * returns a `StructuredResult`. Trust invariants enforced here:
 *  - verdict is a deterministic function of cached assertions over the final snapshot;
 *  - any heal event caps the verdict at `needs_review` (never a silent pass);
 *  - exceptions surface as `error` (excluded from pass/fail statistics upstream).
 * A `FakePage` yields identical deterministic verdict/assertions/confidence across runs.
 */

import type { NormalizedTC } from "../intake/schema.ts";
import { type AssertionCache, type AssertionResult, evaluateAssertion } from "../interpret/assertion.ts";
import type { AuthoredPlan } from "../interpret/author.ts";
import { getOrAuthorAssertions, parseStep } from "../interpret/interpret.ts";
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
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

function evidenceRef(kind: string, content: string): string {
	// content-addressed relative ref (no absolute local paths)
	let h = 0;
	for (let i = 0; i < content.length; i++) h = (Math.imul(31, h) + content.charCodeAt(i)) | 0;
	return `evidence/${kind}-${(h >>> 0).toString(16)}`;
}

export async function runScenario(tc: NormalizedTC, opts: RunOptions): Promise<StructuredResult> {
	const now = opts.now ?? Date.now;
	const start = now();
	const executionId = opts.executionId ?? `${tc.caseId}-${start}`;
	const healEvents: string[] = [];
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

		for (const action of actions) {
			try {
				if (action.kind === "goto") await opts.page.goto(action.path);
				else if (action.kind === "click") await opts.page.click(action.target);
				else if (action.kind === "fill") await opts.page.fill(action.target, action.value);
			} catch (err) {
				// Unactionable target -> record a heal event; do NOT crash and do NOT allow a silent pass.
				healEvents.push(`${action.kind}: ${(err as Error).message}`);
			}
		}

		let snap = await opts.page.snapshot();
		let results = assertions.map((a) => evaluateAssertion(a, snap, { lenient: opts.lenientMatch }));
		// Async content (toasts, late-rendered lists) can appear just after the last action — if an
		// assertion misses, re-snapshot briefly before giving up. Passing-all cases skip this.
		if (assertions.length > 0 && opts.assertRetryMs) {
			const deadline = Date.now() + opts.assertRetryMs;
			while (results.some((r) => !r.passed) && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 400));
				snap = await opts.page.snapshot();
				results = assertions.map((a) => evaluateAssertion(a, snap, { lenient: opts.lenientMatch }));
			}
		}
		if (opts.visionAssert && snap.screenshot) {
			// Text assertion missed the DOM — the expected content may be an image/color. Ask vision.
			for (let i = 0; i < results.length; i++) {
				const r = results[i];
				if (r && !r.passed && r.assertion.kind === "textIncludes") {
					const ok = await opts.visionAssert(snap.screenshot, String(r.assertion.value ?? "")).catch(() => false);
					if (ok) results[i] = { ...r, passed: true, detail: `${r.detail} · 비전 확인` };
				}
			}
			if (results.length === 0 && tc.expected.trim()) {
				// A purely visual expectation with no text assertion — let vision judge the screenshot.
				const ok = await opts.visionAssert(snap.screenshot, tc.expected).catch(() => false);
				if (ok)
					results.push({
						assertion: { kind: "textIncludes", value: tc.expected },
						passed: true,
						detail: `비전 확인: ${tc.expected.replace(/\s+/g, " ").slice(0, 50)}`,
					});
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

		if (verdict === "needs_review" && opts.baseline) {
			const env = opts.baselineEnv ?? opts.env.baseUrl;
			// gate() proposes a pending baseline on first sight; an approved + masked match lifts to pass.
			if (opts.baseline.gate(tc.caseId, opts.rule.ruleVersion, env, snap.text).status === "match") {
				verdict = "pass";
				confidence = 0.9;
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
