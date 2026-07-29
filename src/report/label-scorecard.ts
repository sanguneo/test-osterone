/**
 * Score a live run against the human verdicts a QA team already recorded in the sheet.
 *
 * `report/benchmark.ts` answers "is the engine deterministic" using a fixture model and never touches
 * a real model or browser. This answers the other question — "does the engine agree with a person on
 * a real app" — and the number that matters is **false-pass**: a case a human filed as a defect that
 * the engine called green. That is the failure mode the project treats as fatal, and it cannot be
 * measured without human labels.
 *
 * Scoring is pure so it is testable without a browser; the caller supplies the run results and the
 * label column.
 */

import type { Verdict } from "../execute/runner.ts";

/** A human verdict as QA sheets actually spell it. */
export type HumanVerdict = "pass" | "fail" | "unlabeled";

/**
 * Read a sheet's verdict cell. `NT` (not tested) and `NA` (not applicable) are not verdicts — scoring
 * them as either side would invent agreement or disagreement that nobody expressed.
 */
export function parseHumanVerdict(raw: string | null | undefined): HumanVerdict {
	const t = (raw ?? "").trim().toLowerCase();
	if (t === "pass" || t === "p" || t === "성공" || t === "통과") return "pass";
	if (t === "fail" || t === "f" || t === "실패") return "fail";
	return "unlabeled";
}

export interface ScoredCase {
	caseId: string;
	verdict: Verdict;
	human: HumanVerdict;
	/** Why the engine held this case, when it did — used only to group the holds in the report. */
	holdReason?: string;
	outcome: "agree" | "false-pass" | "false-fail" | "disagree" | "held" | "unlabeled";
}

export interface LabelScorecard {
	total: number;
	agree: number;
	/** Human said fail, engine said pass. The hard gate: this must be 0. */
	falsePass: number;
	/** Human said pass, engine said fail — noisy, but it erodes trust just as fast. */
	falseFail: number;
	/** Engine declined to judge. Not a miss: an honest "a person must look at this". */
	held: number;
	/** Labelled neither pass nor fail (NT/NA/blank), so nothing to agree or disagree with. */
	unlabeled: number;
	/** Held cases grouped by reason, most common first. */
	holdsByReason: { reason: string; count: number }[];
	cases: ScoredCase[];
}

export interface ScoreInput {
	caseId: string;
	verdict: Verdict;
	/** Raw sheet cell, e.g. "Pass" / "Fail" / "NT" / "". */
	human?: string | null;
	holdReason?: string;
}

/** Score a run's cases against their human labels. */
export function scoreAgainstLabels(rows: readonly ScoreInput[]): LabelScorecard {
	const cases: ScoredCase[] = [];
	const reasons = new Map<string, number>();
	for (const row of rows) {
		const human = parseHumanVerdict(row.human);
		let outcome: ScoredCase["outcome"];
		if (row.verdict === "needs_review" || row.verdict === "error") {
			outcome = "held";
			const reason = row.holdReason?.trim() || "(unspecified)";
			reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
		} else if (human === "unlabeled") outcome = "unlabeled";
		else if (human === row.verdict) outcome = "agree";
		else if (human === "fail" && row.verdict === "pass") outcome = "false-pass";
		else if (human === "pass" && row.verdict === "fail") outcome = "false-fail";
		else outcome = "disagree";
		cases.push({ caseId: row.caseId, verdict: row.verdict, human, holdReason: row.holdReason, outcome });
	}
	const count = (o: ScoredCase["outcome"]) => cases.filter((c) => c.outcome === o).length;
	return {
		total: cases.length,
		agree: count("agree"),
		falsePass: count("false-pass"),
		falseFail: count("false-fail"),
		held: count("held"),
		unlabeled: count("unlabeled"),
		holdsByReason: [...reasons]
			.map(([reason, c]) => ({ reason, count: c }))
			.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
		cases,
	};
}

/** One-line summary, the shape a run log or CI job wants. */
export function formatScorecard(s: LabelScorecard): string {
	return [
		`total ${s.total}`,
		`agree ${s.agree}`,
		`false-pass ${s.falsePass}`,
		`false-fail ${s.falseFail}`,
		`held ${s.held}`,
		`unlabeled ${s.unlabeled}`,
	].join(" · ");
}
