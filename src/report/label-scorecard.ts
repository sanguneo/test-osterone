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
import type { NormalizedTC } from "../intake/schema.ts";

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

export interface SheetLabel {
	label: string;
	source: string;
	note: string;
}

/** Pair normalized records by semantic identity, never by a numeric ID that restarts in each tab. */
export function labelsByCase(
	cases: readonly Pick<NormalizedTC, "caseId" | "sourceId" | "category" | "recordedVerdict" | "note">[],
): Map<string, SheetLabel> {
	const labels = new Map<string, SheetLabel>();
	for (const tc of cases) {
		const source = [tc.category, tc.sourceId ?? tc.caseId].filter(Boolean).join(" / ");
		const cells = (tc.recordedVerdict ?? "")
			.split(/\r?\n/)
			.map((value) => value.trim())
			.filter(Boolean);
		const verdicts = new Set(cells.map(parseHumanVerdict).filter((value) => value !== "unlabeled"));
		if (verdicts.size > 1)
			throw new Error(`Conflicting recorded verdicts for ${source}; select a specific verdict column.`);
		const label = cells.find((value) => parseHumanVerdict(value) !== "unlabeled") ?? cells[0] ?? "";
		const previous = labels.get(tc.caseId);
		const before = parseHumanVerdict(previous?.label);
		const current = parseHumanVerdict(label);
		if (previous && before !== "unlabeled" && current !== "unlabeled" && before !== current) {
			throw new Error(`Conflicting labels for duplicate case ${tc.caseId}: ${previous.source} and ${source}`);
		}
		if (!previous || (before === "unlabeled" && current !== "unlabeled")) {
			labels.set(tc.caseId, { label, source, note: tc.note ?? "" });
		}
	}
	return labels;
}

/** A cancelled, filtered, duplicated, or stale run cannot be scored as the complete current sheet. */
export function requireCompleteRun(expectedCaseIds: readonly string[], results: readonly { caseId: string }[]): void {
	const expected = new Set(expectedCaseIds);
	if (expected.size === 0) throw new Error("Cannot score an empty sheet.");
	const seen = new Set<string>();
	for (const result of results) {
		if (!expected.has(result.caseId)) throw new Error(`Run contains an unknown or stale case: ${result.caseId}`);
		if (seen.has(result.caseId)) throw new Error(`Run contains a duplicate result: ${result.caseId}`);
		seen.add(result.caseId);
	}
	if (seen.size !== expected.size) {
		throw new Error(`Incomplete run: ${seen.size} of ${expected.size} current cases were recorded.`);
	}
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
