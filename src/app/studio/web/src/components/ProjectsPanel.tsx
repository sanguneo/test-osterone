import { useEffect, useState } from "react";
import { api } from "../api";
import { getLang, useLang } from "../i18n";
import type { Project } from "../types";
import { ProjectEnvironmentSection, type ProjectDraft } from "./ProjectFormSections";

const S = {
	ko: {
		saving: "저장 중…",
		saved: "저장됨",
		saveFail: (message: string) => `저장 실패: ${message} — 다시 시도하세요.`,
		title: "프로젝트",
		editProject: "프로젝트 편집",
		newProject: "새 프로젝트",
		nameLabel: "이름",
		namePlaceholder: "예: 우리 서비스 회귀",
		sheetsHint: "테스트 시트(원본)는 저장 후 워크스페이스의 “+시트 / XLSX 가져오기”에서 추가합니다.",
		save: "저장",
		cancel: "취소",
	},
	en: {
		saving: "Saving…",
		saved: "Saved",
		saveFail: (message: string) => `Save failed: ${message} — try again.`,
		title: "Projects",
		editProject: "Edit Project",
		newProject: "New Project",
		nameLabel: "Name",
		namePlaceholder: "e.g. Our service regression",
		sheetsHint: 'Test sheets (sources) are added after saving, from "+Sheet / Import XLSX" in the workspace.',
		save: "Save",
		cancel: "Cancel",
	},
} as const;

function blankDraft(): ProjectDraft {
	return { id: "", name: "", sheets: [], baseUrl: "", env: "", accounts: [], referenceRepo: "", aiInterpret: false, lenientMatch: false };
}

function editorFromProject(project: Project | null): ProjectDraft {
	if (!project) return blankDraft();
	return {
		id: project.id,
		name: project.name,
		sheets: project.sheets.map((sheet) => ({ ...sheet })),
		baseUrl: project.baseUrl,
		env: project.env,
		accounts: project.accounts ?? [],
		referenceRepo: project.referenceRepo,
		aiInterpret: project.aiInterpret,
		lenientMatch: project.lenientMatch,
	};
}

export function ProjectsPanel({ initialProject, onSaved, onClose }: { readonly initialProject: Project | null; readonly projects: Project[]; readonly onSaved: (savedId: string, projects: Project[]) => void; readonly onClose: () => void }) {
	const t = S[useLang()];
	const [draft, setDraft] = useState<ProjectDraft>(() => editorFromProject(initialProject));
	const [statusMessage, setStatusMessage] = useState("");
	const [statusError, setStatusError] = useState(false);
	const [dirty, setDirty] = useState(false);

	useEffect(() => {
		if (!dirty) return;
		function warn(event: BeforeUnloadEvent) {
			event.preventDefault();
		}
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);

	function note(message: string, isError = false) {
		setStatusMessage(message);
		setStatusError(isError);
	}
	function updateDraft(patch: Partial<ProjectDraft>) {
		setDraft((current) => ({ ...current, ...patch }));
		setDirty(true);
	}

	function payload() {
		return {
			id: draft.id || undefined,
			projectId: draft.id || "sample",
			sample: false,
			name: draft.name.trim() || "Untitled",
			sheets: draft.sheets,
			baseUrl: draft.baseUrl.trim(),
			env: draft.env.trim(),
			accounts: draft.accounts,
			referenceRepo: draft.referenceRepo.trim(),
			aiInterpret: draft.aiInterpret,
			lenientMatch: draft.lenientMatch,
		};
	}
	async function save() {
		const tt = S[getLang()];
		note(tt.saving);
		try {
			const result = await api.saveProject(payload());
			setDirty(false);
			note(tt.saved);
			onSaved(result.saved.id, result.projects);
			onClose();
		} catch (error) {
			note(tt.saveFail((error as Error).message), true);
		}
	}

	return (
		<section>
			<h2 className="sec">{t.title}</h2>
			<div className="card project-editor">
				<b>{draft.id ? t.editProject : t.newProject}</b>
				<label htmlFor="project-name">{t.nameLabel}</label>
				<input id="project-name" type="text" value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} placeholder={t.namePlaceholder} />
				<ProjectEnvironmentSection draft={draft} onUpdate={updateDraft} />
				<p className="detail">{t.sheetsHint}</p>
				<div className="editor-actions">
					<button className="run" type="button" onClick={save}>{t.save}</button>
					<button className="button secondary" type="button" onClick={onClose}>{t.cancel}</button>
					<span className={statusError ? "err" : "muted"}>{statusMessage}</span>
				</div>
			</div>
		</section>
	);
}
