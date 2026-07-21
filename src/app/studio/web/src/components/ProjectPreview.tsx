import type { PreviewResult } from "../types";

export function ProjectPreview({ preview }: { readonly preview: PreviewResult }) {
	return (
		<div className="project-preview">
			<div className="summary"><span className="chip">케이스 <b>{preview.counts.unique}</b></span><span className="chip review-chip">중복 <b>{preview.counts.duplicates}</b></span></div>
			<p className="detail">열 매핑: {Object.keys(preview.mapping).length ? Object.entries(preview.mapping).map(([key, value]) => `${key}→${value}`).join("   ") : "(자동감지 실패 — 규칙·해석 탭에서 시트 해석)"}</p>
			<div className="tscroll">
				<table>
					<thead><tr><th>제목</th><th>스텝</th><th>기대결과</th></tr></thead>
					<tbody>{preview.unique.slice(0, 30).map((testCase) => <tr key={testCase.caseId}><td>{testCase.title || testCase.caseId}</td><td className="detail">{testCase.steps.join(" · ")}</td><td className="detail">{testCase.expected}</td></tr>)}</tbody>
				</table>
			</div>
			{preview.unique.length > 30 && <p className="table-foot">외 {preview.unique.length - 30}개 케이스는 표시를 생략했습니다.</p>}
			{preview.duplicates.length > 0 && <p className="duplicate-note">중복 제거: {preview.duplicates.map((item) => `${item.title} ↔ ${item.duplicateOf}`).join(", ")}</p>}
		</div>
	);
}
