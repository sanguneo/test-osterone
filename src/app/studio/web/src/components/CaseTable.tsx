import { Fragment, type KeyboardEvent, useRef, useState } from "react";
import { formatAssertion, useLang } from "../i18n";
import type { CaseView } from "../types";
import { Icon } from "./Icon";
import { SelfHealNote, stripAnsi, VerdictMark } from "./Verdict";

const S = {
	ko: {
		caseCol: "케이스",
		verdictCol: "판정",
		verifyCol: "검증",
		confidenceCol: "신뢰도",
		detailCol: "상세",
		tcToggle: "원본 TC",
		preconditionLabel: "사전조건",
		stepsLabel: "테스트 내용",
		expectedLabel: "기대 결과",
		recordedLabel: "시트 기록",
		noteLabel: "비고",
		noExpected: "(기대 결과 없음)",
		review: "리뷰 →",
	},
	en: {
		caseCol: "Case",
		verdictCol: "Verdict",
		verifyCol: "Verify",
		confidenceCol: "Confidence",
		detailCol: "Detail",
		tcToggle: "Original TC",
		preconditionLabel: "Precondition",
		stepsLabel: "Test steps",
		expectedLabel: "Expected result",
		recordedLabel: "Recorded in the sheet",
		noteLabel: "Note",
		noExpected: "(no expected result)",
		review: "Review →",
	},
} as const;

/** Steps usually carry their own "1." / "2)" prefix; strip it so the <ol> numbering doesn't double up. */
const stripStepOrdinal = (s: string) => s.replace(/^\s*\d+[.)]\s+/, "");

/**
 * The one table that renders a run's cases — used by the run bench while a run streams and by the
 * status view for a run already recorded.
 *
 * It exists because there were two of these. They drifted, as duplicated widgets do: the columns
 * came in a different order, one listed every check and the other only the first failure, and the
 * original-TC expander only ever reached one of them. A reader moving between the two screens saw
 * "the same table" disagree with itself about the same run.
 *
 * `onReview` is what separates the two uses. Given one, the table is something you act from — rows
 * take focus, arrow keys walk them, and a held case offers the route to its review. Without it the
 * table is a live readout of a run in progress, where there is nothing to act on yet.
 */
export function CaseTable({
	results,
	onReview,
}: {
	readonly results: readonly CaseView[];
	readonly onReview?: (caseId: string) => void;
}) {
	const lang = useLang();
	const t = S[lang];
	const tbodyRef = useRef<HTMLTableSectionElement>(null);
	// Which case has its original TC open. The sheet's own wording is what a verdict has to be read
	// against, and it is long — so it expands per row instead of crowding the table.
	const [openTc, setOpenTc] = useState("");

	function onRowKey(event: KeyboardEvent<HTMLTableRowElement>, result: CaseView) {
		if (event.key === "Enter" && result.verdict === "needs_review") {
			onReview?.(result.caseId);
			return;
		}
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		const rows = Array.from(tbodyRef.current?.querySelectorAll("tr[tabindex]") ?? []);
		const index = rows.indexOf(event.currentTarget);
		(rows[event.key === "ArrowDown" ? index + 1 : index - 1] as HTMLElement | undefined)?.focus();
	}

	return (
		<div className="tscroll">
			<table className="queue">
				<thead>
					<tr>
						<th>{t.caseCol}</th>
						<th>{t.verdictCol}</th>
						<th className="num">{t.verifyCol}</th>
						<th className="num">{t.confidenceCol}</th>
						<th>{t.detailCol}</th>
					</tr>
				</thead>
				<tbody ref={tbodyRef}>
					{results.map((result) => {
						const open = openTc === result.caseId;
						const hasTc = result.steps?.length > 0 || !!result.expected || !!result.precondition;
						return (
							<Fragment key={result.caseId}>
								<tr
									{...(onReview ? { tabIndex: 0, onKeyDown: (e: KeyboardEvent<HTMLTableRowElement>) => onRowKey(e, result) } : {})}
								>
									<td className="ttl">
										{result.category && <span className="cat-tag">{result.category}</span>}
										{result.title || result.caseId}
										{hasTc && (
											<button
												type="button"
												className="mini tc-toggle"
												aria-expanded={open}
												onClick={() => setOpenTc(open ? "" : result.caseId)}
											>
												{t.tcToggle}
											</button>
										)}
									</td>
									<td>
										<VerdictMark verdict={result.verdict} />
									</td>
									<td className="num">
										{result.passed}/{result.total}
									</td>
									<td className="num">{result.confidence.toFixed(2)}</td>
									<td>
										{result.assertions.map((assertion, index) => (
											<div className="detail assertion-detail" key={`${result.caseId}-${index}`}>
												<span className={assertion.passed ? "o" : "x"}>
													<Icon name={assertion.passed ? "check" : "x"} size={14} />
												</span>
												{stripAnsi(formatAssertion(assertion, lang))}
											</div>
										))}
										<SelfHealNote heal={result.heal} />
										{onReview && result.verdict === "needs_review" && (
											<button className="linkbtn" type="button" onClick={() => onReview(result.caseId)}>
												{t.review}
											</button>
										)}
									</td>
								</tr>
								{open && (
									<tr className="tc-row">
										<td colSpan={5}>
											<div className="rev-tc">
												{result.precondition && (
													<>
														<span className="lbl">{t.preconditionLabel}</span>
														<p className="rev-expected">{result.precondition}</p>
													</>
												)}
												{result.steps?.length > 0 && (
													<>
														<span className="lbl">{t.stepsLabel}</span>
														<ol className="rev-steps">
															{result.steps.map((s, i) => (
																<li key={`${result.caseId}-tcs${i}`}>{stripStepOrdinal(s)}</li>
															))}
														</ol>
													</>
												)}
												<span className="lbl">{t.expectedLabel}</span>
												<p className="rev-expected">{result.expected || t.noExpected}</p>
												{(result.recordedVerdict || result.note) && (
													<>
														<span className="lbl">{t.recordedLabel}</span>
														<p className="rev-expected">
															{result.recordedVerdict}
															{result.note ? `${result.recordedVerdict ? " · " : ""}${t.noteLabel}: ${result.note}` : ""}
														</p>
													</>
												)}
											</div>
										</td>
									</tr>
								)}
							</Fragment>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}
