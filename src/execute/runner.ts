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
import type { Page } from "./page.ts";

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

		const snap = await opts.page.snapshot();
		const results = assertions.map((a) => evaluateAssertion(a, snap));
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

		return {
			...base,
			verdict,
			confidence,
			assertions: results,
			evidenceRefs,
			healEvents,
			timing: { ms: now() - start },
			attempts: 1,
		};
	} catch (err) {
		return {
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
