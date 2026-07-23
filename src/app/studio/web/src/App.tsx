import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { ProjectHome } from "./components/ProjectHome";
import { DashboardPanel } from "./components/DashboardPanel";
import { Icon } from "./components/Icon";
import { ModalShell } from "./components/ModalShell";
import { ModelPanel } from "./components/ModelPanel";
import { ProjectsPanel } from "./components/ProjectsPanel";
import { ReviewPanel } from "./components/ReviewPanel";
import { RulesPanel } from "./components/RulesPanel";
import { RunPanel } from "./components/RunPanel";
import { SheetEditorModal } from "./components/SheetEditorModal";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { StudioChrome, type StudioTab } from "./components/StudioChrome";
import type { Project, Status, TestSheet } from "./types";
import { useLang, getLang } from "./i18n";

const S = {
	ko: {
		modelConnect: "모델 연결",
		project: "프로젝트",
		noSheetSelected: "시트 선택 안됨",
		projectLoadError: "프로젝트 목록을 불러오지 못했습니다: ",
		retry: "다시 시도",
		confirmDeleteProject: (name: string, count: number) => `“${name}”의 시트 ${count}개와 실행 설정을 삭제합니다. 계속할까요?`,
		confirmDeleteProjectFinal: "이 프로젝트는 복구할 수 없습니다. 삭제를 확정할까요?",
		confirmRemoveSheet: (name: string) => `“${name}”의 규칙, 실행 기록, baseline 연결을 제거합니다. 계속할까요?`,
		confirmRemoveSheetFinal: "이 시트 연결은 복구할 수 없습니다. 제거를 확정할까요?",
	},
	en: {
		modelConnect: "Connect model",
		project: "Project",
		noSheetSelected: "No sheet selected",
		projectLoadError: "Failed to load projects: ",
		retry: "Retry",
		confirmDeleteProject: (name: string, count: number) => `This deletes "${name}"'s ${count} sheet${count === 1 ? "" : "s"} and run settings. Continue?`,
		confirmDeleteProjectFinal: "This project can't be recovered. Confirm delete?",
		confirmRemoveSheet: (name: string) => `This removes "${name}"'s rules, run history, and baseline link. Continue?`,
		confirmRemoveSheetFinal: "This sheet link can't be recovered. Confirm removal?",
	},
} as const;
const REASONING_LABEL: Record<string, string> = {
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "xHigh",
	max: "Max",
};

/** Header pill label: provider · model · reasoning, each properly cased. */
function modelStatusLabel(auth: NonNullable<Status["auth"]>): string {
	let provider = "ChatGPT";
	if (auth.mode === "api-key") {
		try {
			provider = new URL(auth.endpoint ?? "").hostname.replace(/^www\./, "") || "API";
		} catch {
			provider = "API";
		}
	}
	const parts = [provider, auth.model];
	if (auth.reasoning) parts.push(REASONING_LABEL[auth.reasoning] ?? auth.reasoning);
	return parts.join(" · ");
}

const ROUTE_TABS: StudioTab[] = ["dash", "rules", "run", "review"];
function decodeSeg(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
/** Read the current view (project/sheet/tab) from the URL path: /p/{project}/{sheet}/{tab}. */
function readRoute(): { project: string; sheet: string; tab: StudioTab } {
	const segs = window.location.pathname.split("/").filter(Boolean);
	if (segs[0] !== "p") return { project: "", sheet: "", tab: "dash" };
	const rawTab = segs[3] ?? "";
	return {
		project: segs[1] ? decodeSeg(segs[1]) : "",
		sheet: segs[2] ? decodeSeg(segs[2]) : "",
		tab: ((ROUTE_TABS as string[]).includes(rawTab) ? rawTab : "dash") as StudioTab,
	};
}
/** Build the URL path for a view; the bare "/" is the Welcome screen. */
function routePath(project: string, sheet: string, tab: StudioTab): string {
	if (!project) return "/";
	let path = `/p/${encodeURIComponent(project)}`;
	if (sheet) {
		path += `/${encodeURIComponent(sheet)}`;
		if (tab !== "dash") path += `/${tab}`;
	}
	return path;
}

export function App() {
	const t = S[useLang()];
	const [projects, setProjects] = useState<Project[]>([]);
	const [selectedProjectId, setSelectedProjectId] = useState(() => readRoute().project);
	const [selectedSheetId, setSelectedSheetId] = useState(() => readRoute().sheet);
	const [status, setStatus] = useState<Status | null>(null);
	const [tab, setTab] = useState<StudioTab>(() => readRoute().tab);
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
		() => projects.find((project) => project.id === selectedProjectId),
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
		const probe = document.createElement("div");
		probe.style.cssText = "position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll;visibility:hidden";
		document.body.appendChild(probe);
		const width = probe.offsetWidth - probe.clientWidth;
		probe.remove();
		document.documentElement.style.setProperty("--sbw", `${width}px`);
	}, []);
	useEffect(() => {
		api.reviewQueue(selectedProjectId, selectedSheetId || undefined).then((queue) => setNavReviewCount(queue.length)).catch(() => {});
	}, [selectedProjectId, selectedSheetId, runSequence, reviewCount]);
	useEffect(() => {
		if (!selectedProject) return;
		if (!selectedProject.sheets.some((sheet) => sheet.id === selectedSheetId)) {
			setSelectedSheetId("");
		}
	}, [selectedProject, selectedSheetId]);
	const routeSynced = useRef(false);
	useEffect(() => {
		const path = routePath(selectedProjectId, selectedSheetId, tab);
		if (path !== window.location.pathname) {
			if (routeSynced.current) window.history.pushState(null, "", path);
			else window.history.replaceState(null, "", path);
		}
		routeSynced.current = true;
	}, [selectedProjectId, selectedSheetId, tab]);
	useEffect(() => {
		const onPop = () => {
			const route = readRoute();
			setSelectedProjectId(route.project);
			setSelectedSheetId(route.sheet);
			setTab(route.tab);
		};
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

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
				accounts: selectedProject.accounts,
				referenceRepo: selectedProject.referenceRepo,
				aiInterpret: selectedProject.aiInterpret,
			});
			setProjects(result.projects);
		} catch (error) {
			setProjectError((error as Error).message);
		}
	}, [selectedProject]);

	const deleteProject = useCallback(async (id: string) => {
		const t = S[getLang()];
		const target = projects.find((project) => project.id === id);
		if (!target || !window.confirm(t.confirmDeleteProject(target.name, target.sheets.length))) return;
		if (!window.confirm(t.confirmDeleteProjectFinal)) return;
		try {
			const result = await api.deleteProject(id);
			setProjects(result.projects);
			if (selectedProjectId === id) setSelectedProjectId("");
		} catch (error) {
			setProjectError((error as Error).message);
		}
	}, [projects, selectedProjectId]);

	const removeSheet = useCallback(async (id: string) => {
		const t = S[getLang()];
		if (!selectedProject) return;
		const target = selectedProject.sheets.find((sheet) => sheet.id === id);
		if (!target || !window.confirm(t.confirmRemoveSheet(target.name))) return;
		if (!window.confirm(t.confirmRemoveSheetFinal)) return;
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
				connected={connected}
				modelLabel={connected && status?.auth ? modelStatusLabel(status.auth) : t.modelConnect}
				navReviewCount={navReviewCount}
				onAddProject={openNewProject}
				onAddSheet={openNewSheet}
				onDeleteProject={deleteProject}
				onEditProject={(project) => { setEditingProject(project); setProjectModalOpen(true); }}
				onEditSheet={(sheet) => { setEditingSheet(sheet); setSheetModalOpen(true); }}
				onHome={() => { setSelectedProjectId(""); setSelectedSheetId(""); }}
				onModelOpen={() => setModelOpen(true)}
				onRemoveSheet={removeSheet}
				onSelectProject={(id) => { if (id === selectedProjectId) setSelectedSheetId(""); setSelectedProjectId(id); }}
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
						<span>{t.projectLoadError}{projectError}</span>
						<button className="button secondary compact" type="button" onClick={loadProjects}>{t.retry}</button>
					</div>
				)}
				{!selectedProject ? (
					<WelcomeScreen projects={projects} onSelectProject={setSelectedProjectId} onNewProject={openNewProject} />
				) : !selectedSheetId ? (
					<ProjectHome project={selectedProject} onSelectSheet={setSelectedSheetId} onAddSheet={openNewSheet} />
				) : (
					<>
						<div hidden={tab !== "dash"}>
							<DashboardPanel selId={selectedProjectId} project={selectedProject} selSheetId={selectedSheetId} reviewCount={navReviewCount} goTo={setTab} refreshKey={runSequence} onRefresh={() => setRunSequence((value) => value + 1)} />
						</div>
						<div hidden={tab !== "rules"}>
							<RulesPanel status={status} selId={selectedProjectId} project={selectedProject} selSheetId={selectedSheetId} connected={connected} onStatus={setStatus} goToModel={() => setModelOpen(true)} />
						</div>
						<div hidden={tab !== "run"}>
							<RunPanel key={`${selectedProjectId}:${selectedSheetId}`} project={selectedProject} selId={selectedProjectId} selSheetId={selectedSheetId} onDone={() => setRunSequence((value) => value + 1)} />
						</div>
						<div hidden={tab !== "review"}>
							<ReviewPanel selId={selectedProjectId} selSheetId={selectedSheetId} sheetName={selectedProject.sheets.find((sheet) => sheet.id === selectedSheetId)?.name ?? t.noSheetSelected} onCount={setReviewCount} onRun={() => setTab("run")} refreshKey={runSequence} />
						</div>
					</>
				)}
			</main>

			{modelOpen && <ModalShell label={t.modelConnect} onClose={closeModel}><ModelPanel status={status} selId={selectedProjectId} onStatus={setStatus} onClose={closeModel} /></ModalShell>}
			{projectModalOpen && (
				<ModalShell label={t.project} onClose={closeProjectModal} wide>
					<ProjectsPanel key={editingProject?.id ?? "new-project"} initialProject={editingProject} projects={projects} onSaved={(savedId, nextProjects) => { setProjects(nextProjects); setSelectedProjectId(savedId); }} onClose={closeProjectModal} />
				</ModalShell>
			)}
			{sheetModalOpen && selectedProject && (
				<SheetEditorModal
					editSheet={editingSheet}
					projectId={selectedProject.id}
					accounts={selectedProject.accounts}
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
					onImportSheets={(imported) => {
						void persistSheets([...selectedProject.sheets, ...imported]);
						if (imported[0]) setSelectedSheetId(imported[0].id);
						setSheetModalOpen(false);
					}}
				/>
			)}
		</div>
	);
}
