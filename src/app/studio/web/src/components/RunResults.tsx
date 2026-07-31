import { Fragment, useState } from "react";
import { formatAssertion, useLang } from "../i18n";
import type { CaseView, Verdict } from "../types";
import { Icon } from "./Icon";
import { SelfHealNote, stripAnsi, VerdictCounts, VerdictMark } from "./Verdict";

const S = {
	ko: {
		progress: (a: number, b: number) => `진행 ${a}/${b}`,
		interpret: "해석",
		ai: "AI",
		rule: "규칙",
		caseCol: "케이스",
		verdictCol: "판정",
		confidenceCol: "신뢰도",
		verifyCol: "검증",
		detailCol: "상세",
		tcToggle: "원본 TC",
		preconditionLabel: "사전조건",
		stepsLabel: "테스트 내용",
		expectedLabel: "기대 결과",
		recordedLabel: "시트 기록",
		noteLabel: "비고",
		noExpected: "(기대 결과 없음)",
	},
	en: {
		progress: (a: number, b: number) => `Progress ${a}/${b}`,
		interpret: "Interpreter",
		ai: "AI",
		rule: "Rule",
		caseCol: "Case",
		verdictCol: "Verdict",
		confidenceCol: "Confidence",
		verifyCol: "Verify",
		detailCol: "Detail",
		tcToggle: "Original TC",
		preconditionLabel: "Precondition",
		stepsLabel: "Test steps",
		expectedLabel: "Expected result",
		recordedLabel: "Recorded in the sheet",
		noteLabel: "Note",
		noExpected: "(no expected result)",
	},
} as const;

/** Steps usually carry their own "1." / "2)" prefix; strip it so the <ol> numbering doesn't double up. */
const stripStepOrdinal = (s: string) => s.replace(/^\s*\d+[.)]\s+/, "");

export interface RunViewLike {
	readonly baseUrl: string;
	readonly interpreter: "ai" | "rule";
	readonly counts: Record<Verdict, number>;
	readonly results: CaseView[];
}

export function RunResults({ view, total }: { readonly view: RunViewLike; readonly total?: number }) {
	const lang = useLang();
	const t = S[lang];
	// Which case has its original TC open. The sheet's own wording is what a verdict has to be read
	// against, and it is long — so it expands per row instead of crowding the table.
	const [openTc, setOpenTc] = useState("");
	return (
		<div className="run-results">
			<div className="summary">
				{total !== undefined && total > view.results.length ? (
					<b>{t.progress(view.results.length, total)}</b>
				) : (
					<span className="chip">{t.interpret} <b>{view.interpreter === "ai" ? t.ai : t.rule}</b></span>
				)}
				<VerdictCounts counts={view.counts} />
			</div>
			<div className="tscroll">
				<table>
					<thead><tr><th>{t.caseCol}</th><th>{t.verdictCol}</th><th className="num">{t.confidenceCol}</th><th className="num">{t.verifyCol}</th><th>{t.detailCol}</th></tr></thead>
					<tbody>
						{view.results.map((result) => {
							const open = openTc === result.caseId;
							const hasTc = result.steps.length > 0 || !!result.expected || !!result.precondition;
							return (
								<Fragment key={result.caseId}>
									<tr>
										<td>
											{result.category && <span className="cat-tag">{result.category}</span>}
											{result.title}
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
										<td><VerdictMark verdict={result.verdict} /></td>
										<td className="num">{result.confidence.toFixed(2)}</td>
										<td className="num">{result.passed}/{result.total}</td>
										<td>
											{result.assertions.map((assertion, index) => (
												<div className="detail assertion-detail" key={`${result.caseId}-${index}`}>
													<span className={assertion.passed ? "o" : "x"}><Icon name={assertion.passed ? "check" : "x"} size={14} /></span>
													{stripAnsi(formatAssertion(assertion, lang))}
												</div>
											))}
											<SelfHealNote heal={result.heal} />
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
													{result.steps.length > 0 && (
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
		</div>
	);
}
