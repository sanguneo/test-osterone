/**
 * Benchmark harness + hard gate. Runs a labeled case set through the pipeline and
 * measures the two v1 success metrics: (1) selection/triage accuracy vs human labels,
 * (2) verdict reliability = per-case determinism (K identical reruns) + false-pass
 * count (labeled-fail cases that the runner passed). The gate is fail-closed on
 * false-pass and determinism.
 */

import type { Page } from "../execute/page.ts";
import { determinismView, type RunEnv, runScenario, type Verdict } from "../execute/runner.ts";
import type { NormalizedTC } from "../intake/schema.ts";
import { MemoryAssertionCache } from "../interpret/assertion.ts";
import type { InterpretationRule } from "../interpret/rule.ts";
import { triageDeterministic } from "../interpret/triage.ts";

export interface LabeledCase {
	tc: NormalizedTC;
	/** Human ground-truth: is this case automatable? */
	automatable: boolean;
	/** For automatable cases: the verdict a correct run should reach. */
	expectedVerdict?: Verdict;
}

export interface LabelSet {
	name: string;
	cases: LabeledCase[];
}

export interface BenchmarkOptions {
	rule: InterpretationRule;
	env: RunEnv;
	makePage: () => Page;
	k?: number;
	now?: () => number;
}

export interface CaseResult {
	caseId: string;
	triageAutomatable: boolean;
	labelAutomatable: boolean;
	selectionCorrect: boolean;
	verdict?: Verdict;
	expectedVerdict?: Verdict;
	deterministic: boolean;
	falsePass: boolean;
}

export interface BenchmarkScore {
	total: number;
	selectionCorrect: number;
	selectionAccuracy: number;
	executed: number;
	deterministicRate: number;
	falsePass: number;
	results: CaseResult[];
}

export async function runBenchmark(set: LabelSet, opts: BenchmarkOptions): Promise<BenchmarkScore> {
	const k = opts.k ?? 5;
	const now = opts.now ?? (() => 0);
	const results: CaseResult[] = [];

	for (const lc of set.cases) {
		const triage = triageDeterministic(lc.tc);
		const result: CaseResult = {
			caseId: lc.tc.caseId,
			triageAutomatable: triage.automatable,
			labelAutomatable: lc.automatable,
			selectionCorrect: triage.automatable === lc.automatable,
			deterministic: true,
			falsePass: false,
		};

		if (lc.automatable) {
			const views: string[] = [];
			let verdict: Verdict | undefined;
			for (let i = 0; i < k; i++) {
				const r = await runScenario(lc.tc, {
					page: opts.makePage(),
					rule: opts.rule,
					cache: new MemoryAssertionCache(),
					env: opts.env,
					now,
					executionId: `${lc.tc.caseId}-${i}`,
				});
				views.push(JSON.stringify(determinismView(r)));
				verdict = r.verdict;
			}
			result.deterministic = views.every((v) => v === views[0]);
			result.verdict = verdict;
			result.expectedVerdict = lc.expectedVerdict;
			result.falsePass = lc.expectedVerdict === "fail" && verdict === "pass";
		}
		results.push(result);
	}

	const total = results.length;
	const selectionCorrect = results.filter((r) => r.selectionCorrect).length;
	const executed = results.filter((r) => r.labelAutomatable).length;
	const deterministicRate =
		executed > 0 ? results.filter((r) => r.labelAutomatable && r.deterministic).length / executed : 1;
	const falsePass = results.filter((r) => r.falsePass).length;

	return {
		total,
		selectionCorrect,
		selectionAccuracy: total > 0 ? selectionCorrect / total : 0,
		executed,
		deterministicRate,
		falsePass,
		results,
	};
}

export interface GateThresholds {
	minSelectionAccuracy: number;
	requireDeterminism: boolean;
	maxFalsePass: number;
}

/** v1 hard gate: false-pass=0, determinism=100%, selection >= 90% (initial bar). */
export const DEFAULT_GATE: GateThresholds = { minSelectionAccuracy: 0.9, requireDeterminism: true, maxFalsePass: 0 };

export interface GateResult {
	passed: boolean;
	failures: string[];
}

export function evaluateGate(score: BenchmarkScore, thresholds: GateThresholds = DEFAULT_GATE): GateResult {
	const failures: string[] = [];
	if (score.selectionAccuracy < thresholds.minSelectionAccuracy) {
		failures.push(
			`selection accuracy ${(score.selectionAccuracy * 100).toFixed(0)}% < ${(thresholds.minSelectionAccuracy * 100).toFixed(0)}%`,
		);
	}
	if (thresholds.requireDeterminism && score.deterministicRate < 1) {
		failures.push(`determinism ${(score.deterministicRate * 100).toFixed(0)}% < 100%`);
	}
	if (score.falsePass > thresholds.maxFalsePass) {
		failures.push(`false-pass ${score.falsePass} > ${thresholds.maxFalsePass}`);
	}
	return { passed: failures.length === 0, failures };
}
