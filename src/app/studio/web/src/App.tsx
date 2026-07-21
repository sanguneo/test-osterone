import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { DashboardPanel } from "./components/DashboardPanel";
import { Icon } from "./components/Icon";
import { ModalShell } from "./components/ModalShell";
import { ModelPanel } from "./components/ModelPanel";
import { ProjectsPanel } from "./components/ProjectsPanel";
import { ReviewPanel } from "./components/ReviewPanel";
import { RulesPanel } from "./components/RulesPanel";
import { RunPanel } from "./components/RunPanel";
import { SheetEditorModal } from "./components/SheetEditorModal";
import { StudioChrome, type StudioTab } from "./components/StudioChrome";
import type { Project, Status, TestSheet } from "./types";

export function App() {
	const [projects, setProjects] = useState<Project[]>([]);
	const [selectedProjectId, setSelectedProjectId] = useState("sample");
	const [selectedSheetId, setSelectedSheetId] = useState("");
	const [status, setStatus] = useState<Status | null>(null);
	const [tab, setTab] = useState<StudioTab>("dash");
	const [reviewCount, setReviewCount] = useState(0);
	const [navReviewCount, setNavReviewCount] = useState(0);
	const [projectError, setProjectError] = useState("");
	const [runSequence, setRunSequence] = useState(0);
	const [modelOpen, setModelOpen] = useState(false);
	const [projectModalOpen, setProjectModalOpen] = useState(false);
	const [editingProject, setEditingProject] = useState<Project | null>(null);
	const [sheetModalOpen, setSheetModalOpen] = useState(false);
	const [editingSheet, setEditingSheet] = useState<TestSheet | null>(null);

	const selectedProject = useMemo(
		() => projects.find((project) => project.id === selectedProjectId) ?? projects[0],
		[projects, selectedProjectId],
	);
	const connected = Boolean(status?.connected);

	const refreshStatus = useCallback(() => {
		api.status(selectedProjectId, selectedSheetId).then((nextStatus) => {
			setStatus(nextStatus);
		}).catch(() => {});
	}, [selectedProjectId, selectedSheetId]);

	const loadProjects = useCallback(() => {
		setProjectError("");
		api.projects().then(setProjects).catch((error) => setProjectError((error as Error).message));
	}, []);

	useEffect(loadProjects, [loadProjects]);
	useEffect(refreshStatus, [refreshStatus]);
	useEffect(() => {
		api.reviewQueue(selectedProjectId, undefined, true).then((queue) => setNavReviewCount(queue.length)).catch(() => {});
	}, [selectedProjectId, runSequence, reviewCount]);
	useEffect(() => {
		if (!selectedProject) return;
		if (!selectedProject.sheets.some((sheet) => sheet.id === selectedSheetId)) {
			setSelectedSheetId(selectedProject.sheets[0]?.id ?? "");
		}
	}, [selectedProject, selectedSheetId]);

	const persistSheets = useCallback(async (nextSheets: TestSheet[]) => {
		if (!selectedProject || selectedProject.id === "sample") return;
		try {
			const result = await api.saveProject({
				id: selectedProject.id,
				projectId: selectedProject.id,
				sample: false,
				name: selectedProject.name,
				sheets: nextSheets,
				baseUrl: selectedProject.baseUrl,
				env: selectedProject.env,
				username: selectedProject.username,
				password: selectedProject.password,
				referenceRepo: selectedProject.referenceRepo,
				aiInterpret: selectedProject.aiInterpret,
			});
			setProjects(result.projects);
		} catch (error) {
			setProjectError((error as Error).message);
		}
	}, [selectedProject]);

	const deleteProject = useCallback(async (id: string) => {
		const target = projects.find((project) => project.id === id);
		if (!target || !window.confirm(`“${target.name}” 프로젝트를 삭제할까요?`)) return;
		try {
			const result = await api.deleteProject(id);
			setProjects(result.projects);
			if (selectedProjectId === id) setSelectedProjectId("sample");
		} catch (error) {
			setProjectError((error as Error).message);
		}
	}, [projects, selectedProjectId]);

	const removeSheet = useCallback(async (id: string) => {
		if (!selectedProject) return;
		const target = selectedProject.sheets.find((sheet) => sheet.id === id);
		if (!target || !window.confirm(`“${target.name}” 시트를 제거할까요?`)) return;
		await persistSheets(selectedProject.sheets.filter((sheet) => sheet.id !== id));
		if (selectedSheetId === id) setSelectedSheetId("");
	}, [persistSheets, selectedProject, selectedSheetId]);

	const openNewProject = useCallback(() => {
		setEditingProject(null);
		setProjectModalOpen(true);
	}, []);
	const openNewSheet = useCallback(() => {
		setEditingSheet(null);
		setSheetModalOpen(true);
	}, []);
	const closeModel = useCallback(() => setModelOpen(false), []);
	const closeProjectModal = useCallback(() => setProjectModalOpen(false), []);

	return (
		<div className="app-shell">
			<StudioChrome
				key={selectedProjectId}
				connected={connected}
				modelLabel={connected && status?.auth ? status.auth.model : "모델 연결"}
				navReviewCount={navReviewCount}
				onAddProject={openNewProject}
				onAddSheet={openNewSheet}
				onDeleteProject={deleteProject}
				onEditProject={(project) => { setEditingProject(project); setProjectModalOpen(true); }}
				onEditSheet={(sheet) => { setEditingSheet(sheet); setSheetModalOpen(true); }}
				onModelOpen={() => setModelOpen(true)}
				onRemoveSheet={removeSheet}
				onSelectProject={setSelectedProjectId}
				onSelectSheet={setSelectedSheetId}
				onTabChange={setTab}
				projects={projects}
				selected={selectedProject}
				selectedProjectId={selectedProjectId}
				selectedSheetId={selectedSheetId}
				tab={tab}
			/>

			<main className="workspace-main" id="workspace-main">
				{projectError && (
					<div className="notice error-notice" role="alert">
						<Icon name="warning" />
						<span>프로젝트 목록을 불러오지 못했습니다: {projectError}</span>
						<button className="button secondary compact" type="button" onClick={loadProjects}>다시 시도</button>
					</div>
				)}
				<div hidden={tab !== "dash"}>
					<DashboardPanel selId={selectedProjectId} project={selectedProject} selSheetId={selectedSheetId} reviewCount={navReviewCount} goTo={setTab} refreshKey={runSequence} />
				</div>
				<div hidden={tab !== "rules"}>
					<RulesPanel status={status} selId={selectedProjectId} project={selectedProject} selSheetId={selectedSheetId} connected={connected} onStatus={setStatus} goToModel={() => setModelOpen(true)} />
				</div>
				<div hidden={tab !== "run"}>
					<RunPanel key={`${selectedProjectId}:${selectedSheetId}`} project={selectedProject} selId={selectedProjectId} selSheetId={selectedSheetId} onDone={() => setRunSequence((value) => value + 1)} />
				</div>
				<div hidden={tab !== "review"}>
					<ReviewPanel selId={selectedProjectId} selSheetId={selectedSheetId} onCount={setReviewCount} refreshKey={runSequence} />
				</div>
			</main>

			{modelOpen && <ModalShell label="모델 연결" onClose={closeModel}><ModelPanel status={status} selId={selectedProjectId} onStatus={setStatus} onClose={closeModel} /></ModalShell>}
			{projectModalOpen && (
				<ModalShell label="프로젝트" onClose={closeProjectModal} wide>
					<ProjectsPanel key={editingProject?.id ?? "new-project"} initialProject={editingProject} projects={projects} onSaved={(savedId, nextProjects) => { setProjects(nextProjects); setSelectedProjectId(savedId); }} onClose={closeProjectModal} />
				</ModalShell>
			)}
			{sheetModalOpen && selectedProject && (
				<SheetEditorModal
					editSheet={editingSheet}
					projectId={selectedProject.id}
					onClose={() => setSheetModalOpen(false)}
					onSave={(sheet) => {
						const nextSheets = editingSheet ? selectedProject.sheets.map((item) => item.id === editingSheet.id ? sheet : item) : [...selectedProject.sheets, sheet];
						void persistSheets(nextSheets);
						setSelectedSheetId(sheet.id);
						setSheetModalOpen(false);
					}}
					onPersist={async (sheet) => {
						const nextSheets = editingSheet ? selectedProject.sheets.map((item) => (item.id === editingSheet.id ? sheet : item)) : [...selectedProject.sheets, sheet];
						await persistSheets(nextSheets);
						setSelectedSheetId(sheet.id);
					}}
				/>
			)}
		</div>
	);
}
