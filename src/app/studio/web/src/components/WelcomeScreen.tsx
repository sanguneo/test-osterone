import type { Project } from "../types";
import { EmptyMotif } from "./DashboardParts";
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
			<div className="card dash-empty">
				<div className="empty-signal">
					<EmptyMotif />
					<span>test-osterone Studio</span>
				</div>
				<div>
					<p className="kicker">test-osterone Studio</p>
					<h2>프로젝트를 선택하거나 새로 만드세요</h2>
					<p>프로젝트는 테스트 시트를 묶어 관리하는 단위입니다. 시트마다 규칙·실행·리뷰가 따로 유지됩니다.</p>
					<div className="welcome-projects">
						{projects.map((project) => (
							<button key={project.id} className="context-item" type="button" onClick={() => onSelectProject(project.id)}>
								{project.name}
							</button>
						))}
					</div>
					<button className="button primary" type="button" onClick={onNewProject}>
						<Icon name="add" />새 프로젝트
					</button>
				</div>
			</div>
		</section>
	);
}
