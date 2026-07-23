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
	},
} as const;

export interface RunViewLike {
	readonly baseUrl: string;
	readonly interpreter: "ai" | "rule";
	readonly counts: Record<Verdict, number>;
	readonly results: CaseView[];
}

export function RunResults({ view, total }: { readonly view: RunViewLike; readonly total?: number }) {
	const lang = useLang();
	const t = S[lang];
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
						{view.results.map((result) => (
							<tr key={result.caseId}>
								<td>{result.category && <span className="cat-tag">{result.category}</span>}{result.title}</td>
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
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
