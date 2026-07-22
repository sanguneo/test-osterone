import type { PreviewResult } from "../types";
import { useLang } from "../i18n";

const S = {
	ko: {
		cases: "케이스",
		duplicates: "중복",
		columnMapping: "열 매핑",
		mappingFail: "(자동감지 실패 — 규칙·해석 탭에서 시트 해석)",
		title: "제목",
		steps: "스텝",
		expected: "기대결과",
		more: (n: number) => `외 ${n}개 케이스는 표시를 생략했습니다.`,
		duplicateRemoval: "중복 제거",
	},
	en: {
		cases: "Cases",
		duplicates: "Duplicates",
		columnMapping: "Column mapping",
		mappingFail: "(auto-detect failed — resolve the sheet in the Rules/Interpret tab)",
		title: "Title",
		steps: "Steps",
		expected: "Expected",
		more: (n: number) => `${n} more case${n === 1 ? "" : "s"} hidden.`,
		duplicateRemoval: "Duplicates removed",
	},
} as const;

export function ProjectPreview({ preview }: { readonly preview: PreviewResult }) {
	const t = S[useLang()];
	return (
		<div className="project-preview">
			<div className="summary"><span className="chip">{t.cases} <b>{preview.counts.unique}</b></span><span className="chip review-chip">{t.duplicates} <b>{preview.counts.duplicates}</b></span></div>
			<p className="detail">{t.columnMapping}: {Object.keys(preview.mapping).length ? Object.entries(preview.mapping).map(([key, value]) => `${key}→${value}`).join("   ") : t.mappingFail}</p>
			<div className="tscroll">
				<table>
					<thead><tr><th>{t.title}</th><th>{t.steps}</th><th>{t.expected}</th></tr></thead>
					<tbody>{preview.unique.slice(0, 30).map((testCase) => <tr key={testCase.caseId}><td>{testCase.title || testCase.caseId}</td><td className="detail">{testCase.steps.join(" · ")}</td><td className="detail">{testCase.expected}</td></tr>)}</tbody>
				</table>
			</div>
			{preview.unique.length > 30 && <p className="table-foot">{t.more(preview.unique.length - 30)}</p>}
			{preview.duplicates.length > 0 && <p className="duplicate-note">{t.duplicateRemoval}: {preview.duplicates.map((item) => `${item.title} ↔ ${item.duplicateOf}`).join(", ")}</p>}
		</div>
	);
}
