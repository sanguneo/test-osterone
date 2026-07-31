import { useLang } from "../i18n";
import type { CaseView, Verdict } from "../types";
import { CaseTable } from "./CaseTable";
import { VerdictCounts } from "./Verdict";

const S = {
	ko: {
		progress: (a: number, b: number) => `진행 ${a}/${b}`,
		interpret: "해석",
		ai: "AI",
		rule: "규칙",
	},
	en: {
		progress: (a: number, b: number) => `Progress ${a}/${b}`,
		interpret: "Interpreter",
		ai: "AI",
		rule: "Rule",
	},
} as const;

export interface RunViewLike {
	readonly baseUrl: string;
	readonly interpreter: "ai" | "rule";
	readonly counts: Record<Verdict, number>;
	readonly results: CaseView[];
}

/**
 * The live readout of a run in flight: how far it has got, and each case as it lands.
 *
 * No filter, no history, no route into review — those belong to the status view, which reads runs
 * that are already finished. This is the feedback for an action you just took, and it stops being
 * the point the moment the run does.
 */
export function RunResults({ view, total }: { readonly view: RunViewLike; readonly total?: number }) {
	const lang = useLang();
	const t = S[lang];
	return (
		<div className="run-results">
			<div className="summary">
				{total !== undefined && total > view.results.length ? (
					<b>{t.progress(view.results.length, total)}</b>
				) : (
					<span className="chip">
						{t.interpret} <b>{view.interpreter === "ai" ? t.ai : t.rule}</b>
					</span>
				)}
				<VerdictCounts counts={view.counts} />
			</div>
			<CaseTable results={view.results} />
		</div>
	);
}
