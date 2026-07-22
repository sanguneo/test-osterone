import { useEffect, useState } from "react";
import { api } from "../api";
import type { PreviewResult, Project, TestSheet, XlsxSheet } from "../types";
import { getLang, useLang } from "../i18n";
import { ProjectEnvironmentSection, ProjectSourceSection, type ProjectDraft } from "./ProjectFormSections";
import { ProjectPreview } from "./ProjectPreview";

const S = {
	ko: {
		newSheetName: "시트",
		pasteName: "붙여넣기",
		xlsxParsing: "XLSX 파싱 중…",
		xlsxFail: (message: string) => `XLSX 변환 실패: ${message} — 파일 형식을 확인하세요.`,
		saving: "저장 중…",
		saved: "저장됨",
		saveFail: (message: string) => `저장 실패: ${message} — 다시 시도하세요.`,
		readingTests: "테스트 읽는 중…",
		readFail: (message: string) => `테스트 읽기 실패: ${message} — 원본 URL과 형식을 확인하세요.`,
		title: "프로젝트",
		editProject: "프로젝트 편집",
		newProject: "새 프로젝트",
		nameLabel: "이름",
		namePlaceholder: "예: 우리 서비스 회귀",
		save: "저장",
		readAndDedupe: "테스트 읽기 & 중복 확인",
		cancel: "취소",
	},
	en: {
		newSheetName: "Sheet",
		pasteName: "Pasted",
		xlsxParsing: "Parsing XLSX…",
		xlsxFail: (message: string) => `XLSX conversion failed: ${message} — check the file format.`,
		saving: "Saving…",
		saved: "Saved",
		saveFail: (message: string) => `Save failed: ${message} — try again.`,
		readingTests: "Reading tests…",
		readFail: (message: string) => `Failed to read tests: ${message} — check the source URL and format.`,
		title: "Projects",
		editProject: "Edit Project",
		newProject: "New Project",
		nameLabel: "Name",
		namePlaceholder: "e.g. Our service regression",
		save: "Save",
		readAndDedupe: "Read Tests & Check Duplicates",
		cancel: "Cancel",
	},
} as const;

function blankDraft(): ProjectDraft {
	return { id: "", name: "", sheets: [], baseUrl: "", env: "", username: "", password: "", referenceRepo: "", aiInterpret: false };
}

function editorFromProject(project: Project | null): ProjectDraft {
	if (!project) return blankDraft();
	return { id: project.id, name: project.name, sheets: project.sheets.map((sheet) => ({ ...sheet })), baseUrl: project.baseUrl, env: project.env, username: project.username, password: project.password, referenceRepo: project.referenceRepo, aiInterpret: project.aiInterpret };
}

export function ProjectsPanel({ initialProject, onSaved, onClose }: { readonly initialProject: Project | null; readonly projects: Project[]; readonly onSaved: (savedId: string, projects: Project[]) => void; readonly onClose: () => void }) {
	const t = S[useLang()];
	const [draft, setDraft] = useState<ProjectDraft>(() => editorFromProject(initialProject));
	const [addMode, setAddMode] = useState<"" | "sheet" | "csv">("");
	const [sheetUrl, setSheetUrl] = useState("");
	const [csvText, setCsvText] = useState("");
	const [xlsxSheets, setXlsxSheets] = useState<XlsxSheet[] | null>(null);
	const [xlsxName, setXlsxName] = useState("");
	const [pick, setPick] = useState<Record<number, boolean>>({});
	const [statusMessage, setStatusMessage] = useState("");
	const [statusError, setStatusError] = useState(false);
	const [preview, setPreview] = useState<PreviewResult | null>(null);
	const [dirty, setDirty] = useState(false);

	useEffect(() => {
		if (!dirty) return;
		function warn(event: BeforeUnloadEvent) { event.preventDefault(); }
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);

	function note(message: string, isError = false) { setStatusMessage(message); setStatusError(isError); }
	function updateDraft(patch: Partial<ProjectDraft>) { setDraft((current) => ({ ...current, ...patch })); setDirty(true); }
	function addSheet() {
		const tt = S[getLang()];
		if (!sheetUrl.trim()) return;
		updateDraft({ sheets: [...draft.sheets, { id: `sh_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, kind: "sheet", name: tt.newSheetName, sheetUrl: sheetUrl.trim(), csvText: "" }] });
		setSheetUrl("");
		setAddMode("");
	}
	function addCsv() {
		const tt = S[getLang()];
		if (!csvText.trim()) return;
		updateDraft({ sheets: [...draft.sheets, { id: `sh_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, kind: "csv", name: tt.pasteName, sheetUrl: "", csvText }] });
		setCsvText("");
		setAddMode("");
	}
	function removeSheet(index: number) { updateDraft({ sheets: draft.sheets.filter((_, currentIndex) => currentIndex !== index) }); }

	async function readXlsx(file: File) {
		const tt = S[getLang()];
		note(tt.xlsxParsing);
		try {
			const base64 = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
				reader.onerror = reject;
				reader.readAsDataURL(file);
			});
			const result = await api.xlsxConvert(base64);
			setXlsxSheets(result.sheets);
			setXlsxName(file.name);
			setPick({});
			note("");
		} catch (error) { note(tt.xlsxFail((error as Error).message), true); }
	}

	function addPicked() {
		if (!xlsxSheets) return;
		const additions: TestSheet[] = [];
		for (const [index, sheet] of xlsxSheets.entries()) {
			if (pick[index]) additions.push({ id: `sh_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, kind: "csv", name: sheet.name, sheetUrl: "", csvText: sheet.csv });
		}
		updateDraft({ sheets: [...draft.sheets, ...additions] });
		setXlsxSheets(null);
	}

	function payload() {
		return { id: draft.id || undefined, projectId: draft.id || "sample", sample: false, name: draft.name.trim() || "Untitled", sheets: draft.sheets, baseUrl: draft.baseUrl.trim(), env: draft.env.trim(), username: draft.username.trim(), password: draft.password, referenceRepo: draft.referenceRepo.trim(), aiInterpret: draft.aiInterpret };
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
		} catch (error) { note(tt.saveFail((error as Error).message), true); }
	}
	async function readPreview() {
		const tt = S[getLang()];
		note(tt.readingTests);
		try {
			setPreview(await api.preview({ sample: false, sheets: draft.sheets, baseUrl: draft.baseUrl, projectId: draft.id || "sample" }));
			note("");
		} catch (error) { setPreview(null); note(tt.readFail((error as Error).message), true); }
	}

	return (
		<section>
			<h2 className="sec">{t.title}</h2>
			<div className="card project-editor">
				<b>{draft.id ? t.editProject : t.newProject}</b>
				<label htmlFor="project-name">{t.nameLabel}</label>
				<input id="project-name" type="text" value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} placeholder={t.namePlaceholder} />
				<ProjectSourceSection draft={draft} addMode={addMode} csvText={csvText} onAddCsv={addCsv} onAddMode={setAddMode} onAddPicked={addPicked} onCsvText={setCsvText} onFile={readXlsx} onPick={(index, checked) => setPick((current) => ({ ...current, [index]: checked }))} onRemoveSheet={removeSheet} onSheetUrl={setSheetUrl} onAddSheet={addSheet} pick={pick} sheetUrl={sheetUrl} xlsxName={xlsxName} xlsxSheets={xlsxSheets} />
				<ProjectEnvironmentSection draft={draft} onUpdate={updateDraft} />
				<div className="editor-actions"><button className="run" type="button" onClick={save}>{t.save}</button><button className="button secondary" type="button" onClick={readPreview}>{t.readAndDedupe}</button><button className="button secondary" type="button" onClick={onClose}>{t.cancel}</button><span className={statusError ? "err" : "muted"}>{statusMessage}</span></div>
				{preview && <ProjectPreview preview={preview} />}
			</div>
		</section>
	);
}
