import type { CaseView, Verdict } from "../types";
import { Icon } from "./Icon";
import { SelfHealNote, stripAnsi, VerdictCounts, VerdictMark } from "./Verdict";

export interface RunViewLike {
	readonly baseUrl: string;
	readonly interpreter: "ai" | "rule";
	readonly counts: Record<Verdict, number>;
	readonly results: CaseView[];
}

export function RunResults({ view, total }: { readonly view: RunViewLike; readonly total?: number }) {
	return (
		<div className="card run-results">
			<div className="summary">
				{total !== undefined && total > view.results.length ? (
					<b>진행 {view.results.length}/{total}</b>
				) : (
					<span className="chip">해석 <b>{view.interpreter === "ai" ? "AI" : "규칙"}</b></span>
				)}
				<VerdictCounts counts={view.counts} />
			</div>
			<div className="tscroll">
				<table>
					<thead><tr><th>케이스</th><th>판정</th><th className="num">신뢰도</th><th className="num">검증</th><th>상세</th></tr></thead>
					<tbody>
						{view.results.map((result) => (
							<tr key={result.caseId}>
								<td>{result.title}</td>
								<td><VerdictMark verdict={result.verdict} /></td>
								<td className="num">{result.confidence.toFixed(2)}</td>
								<td className="num">{result.passed}/{result.total}</td>
								<td>
									{result.assertions.map((assertion, index) => (
										<div className="detail assertion-detail" key={`${result.caseId}-${index}`}>
											<span className={assertion.passed ? "o" : "x"}><Icon name={assertion.passed ? "check" : "x"} size={14} /></span>
											{stripAnsi(assertion.detail)}
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
