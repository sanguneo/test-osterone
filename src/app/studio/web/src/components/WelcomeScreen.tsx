import type { Project } from "../types";
import { useLang } from "../i18n";
import { Icon } from "./Icon";

const S = {
	ko: {
		title: "프로젝트",
		intro: "작업할 프로젝트를 선택하세요. 규칙과 실행 기록은 시트별로 관리됩니다.",
		newProject: "새 프로젝트",
		sheets: (n: number) => `시트 ${n}개`,
	},
	en: {
		title: "Projects",
		intro: "Pick a project to work on. Rules and run history are managed per sheet.",
		newProject: "New Project",
		sheets: (n: number) => `${n} sheet${n === 1 ? "" : "s"}`,
	},
} as const;

export function WelcomeScreen({
	projects,
	onSelectProject,
	onNewProject,
}: {
	readonly projects: Project[];
	readonly onSelectProject: (id: string) => void;
	readonly onNewProject: () => void;
}) {
	const t = S[useLang()];
	return (
		<section className="welcome-screen">
			<div className="welcome-hero" aria-hidden="true">
				<img className="welcome-logo" src="/logo-forged.png" alt="" width={512} height={512} loading="eager" decoding="async" />
			</div>
			<div className="welcome-content">
				<div className="workspace-intro">
					<div>
						<h2>{t.title}</h2>
						<p>{t.intro}</p>
					</div>
					<button className="button primary" type="button" onClick={onNewProject}><Icon name="add" />{t.newProject}</button>
				</div>
				<div className="sheet-grid">
					{projects.map((project) => (
						<button key={project.id} className="sheet-card" type="button" onClick={() => onSelectProject(project.id)}>
							<Icon name="project" />
							<b>{project.name}</b>
							<span className="detail">{t.sheets(project.sheets.length)}{project.baseUrl ? ` · ${project.baseUrl}` : ""}</span>
						</button>
					))}
				</div>
			</div>
		</section>
	);
}
