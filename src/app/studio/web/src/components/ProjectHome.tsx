import type { Project } from "../types";
import { EmptyMotif } from "./DashboardParts";
import { Icon } from "./Icon";

export function ProjectHome({
	project,
	onSelectSheet,
	onAddSheet,
}: {
	readonly project: Project;
	readonly onSelectSheet: (id: string) => void;
	readonly onAddSheet: () => void;
}) {
	return (
		<section>
			<div className="dash-head">
				<div>
					<p className="kicker">Project</p>
					<h2 className="sec">{project.name}</h2>
				</div>
				<span className="ctx">{project.baseUrl || "대상 미설정"} · 시트 {project.sheets.length}개</span>
			</div>
			{project.sheets.length === 0 ? (
				<div className="card dash-empty">
					<div className="empty-signal">
						<EmptyMotif />
						<span>Start here</span>
					</div>
					<div>
						<p className="kicker">Start here</p>
						<h3>첫 테스트 시트를 추가하세요</h3>
						<p>시트를 추가하면 AI가 해석안을 제안하고 대화로 규칙을 다듬은 뒤 실행합니다.</p>
						<button className="button primary" type="button" onClick={onAddSheet}>
							<Icon name="add" />새 시트
						</button>
					</div>
				</div>
			) : (
				<div className="sheet-grid">
					{project.sheets.map((sheet) => (
						<button key={sheet.id} className="sheet-card" type="button" onClick={() => onSelectSheet(sheet.id)}>
							<Icon name="sheet" />
							<b>{sheet.name}</b>
							<div className="detail">{sheet.kind === "sheet" ? "구글 시트" : "CSV"}{sheet.env ? ` · ${sheet.env}` : ""}</div>
						</button>
					))}
					<button className="sheet-card sheet-card-add" type="button" onClick={onAddSheet}>
						<Icon name="add" />새 시트
					</button>
				</div>
			)}
		</section>
	);
}
