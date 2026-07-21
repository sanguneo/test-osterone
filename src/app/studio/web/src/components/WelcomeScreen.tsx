import type { Project } from "../types";
import { Icon } from "./Icon";

export function WelcomeScreen({
	projects,
	onSelectProject,
	onNewProject,
}: {
	readonly projects: Project[];
	readonly onSelectProject: (id: string) => void;
	readonly onNewProject: () => void;
}) {
	return (
		<section>
			<div className="dash-head">
				<div>
					<p className="kicker">test-osterone Studio</p>
					<h2 className="sec">프로젝트</h2>
				</div>
				<span className="ctx">테스트 시트를 묶어 관리하는 단위입니다 · 시트마다 규칙·실행·리뷰가 따로 유지됩니다</span>
			</div>
			<div className="sheet-grid">
				{projects.map((project) => (
					<button key={project.id} className="sheet-card" type="button" onClick={() => onSelectProject(project.id)}>
						<Icon name="project" />
						<b>{project.name}</b>
						<span className="detail">시트 {project.sheets.length}개{project.baseUrl ? ` · ${project.baseUrl}` : ""}</span>
					</button>
				))}
				<button className="sheet-card sheet-card-add" type="button" onClick={onNewProject}>
					<Icon name="add" />새 프로젝트
				</button>
			</div>
		</section>
	);
}
