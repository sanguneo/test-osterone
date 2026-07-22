import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Project, TestSheet } from "../types";
import { Icon, type IconName } from "./Icon";
import { LangToggle } from "./LangToggle";
import { useLang } from "../i18n";

const S = {
	ko: {
		skipLink: "본문으로 건너뛰기",
		brandAria: "test-osterone Studio — 프로젝트 목록으로",
		brandTitle: "프로젝트 목록으로",
		workspaceAria: "작업 컨텍스트",
		project: "프로젝트",
		sheet: "시트",
		projectSearchAria: "프로젝트 검색",
		sheetSearchAria: "시트 검색",
		search: "검색",
		edit: "편집",
		delete: "삭제",
		addProjectAria: "프로젝트 추가",
		addSheetAria: "시트 추가",
		importSheetsAria: "XLSX 가져오기",
		sampleNoSheetAdd: "샘플 프로젝트에는 시트를 추가할 수 없습니다",
		noResults: "검색 결과 없음",
		noSheets: "연결된 시트 없음",
		viewRailAria: "시트 보기",
		nav: {
			dash: "실행 현황",
			rules: "규칙·해석",
			run: "실행 작업대",
			review: "리뷰 대기",
		},
	},
	en: {
		skipLink: "Skip to content",
		brandAria: "test-osterone Studio — back to projects",
		brandTitle: "Back to projects",
		workspaceAria: "Workspace context",
		project: "Project",
		sheet: "Sheet",
		projectSearchAria: "Search projects",
		sheetSearchAria: "Search sheets",
		search: "Search",
		edit: "Edit",
		delete: "Delete",
		addProjectAria: "Add project",
		addSheetAria: "Add sheet",
		importSheetsAria: "Import XLSX",
		sampleNoSheetAdd: "Sample project can't add sheets",
		noResults: "No results",
		noSheets: "No sheets linked",
		viewRailAria: "Sheet view",
		nav: {
			dash: "Dashboard",
			rules: "Rules & interpretation",
			run: "Run bench",
			review: "Review queue",
		},
	},
} as const;

export type StudioTab = "dash" | "rules" | "run" | "review";

interface StudioChromeProps {
	readonly connected: boolean;
	readonly modelLabel: string;
	readonly navReviewCount: number;
	readonly onAddProject: () => void;
	readonly onAddSheet: () => void;
	readonly onImportSheets: () => void;
	readonly onDeleteProject: (id: string) => void;
	readonly onEditProject: (project: Project) => void;
	readonly onEditSheet: (sheet: TestSheet) => void;
	readonly onHome: () => void;
	readonly onModelOpen: () => void;
	readonly onRemoveSheet: (id: string) => void;
	readonly onSelectProject: (id: string) => void;
	readonly onSelectSheet: (id: string) => void;
	readonly onTabChange: (tab: StudioTab) => void;
	readonly projects: Project[];
	readonly selected?: Project;
	readonly selectedProjectId: string;
	readonly selectedSheetId: string;
	readonly tab: StudioTab;
}

const NAV_ITEMS: ReadonlyArray<{ icon: IconName; tab: StudioTab }> = [
	{ icon: "overview", tab: "dash" },
	{ icon: "rules", tab: "rules" },
	{ icon: "play", tab: "run" },
	{ icon: "review", tab: "review" },
];

function revealContextItem(button: HTMLButtonElement | null) {
	if (!button) return;
	const reel = button.closest<HTMLElement>(".context-reel");
	const group = button.parentElement;
	if (!reel || !group) return;
	const itemStart = group.offsetLeft;
	const itemEnd = itemStart + group.offsetWidth;
	if (itemStart < reel.scrollLeft) reel.scrollTo({ left: itemStart });
	else if (itemEnd > reel.scrollLeft + reel.clientWidth) reel.scrollTo({ left: itemEnd - reel.clientWidth });
}

function ContextItem({
	active,
	buttonRef,
	children,
	onClick,
}: {
	readonly active: boolean;
	readonly buttonRef?: RefObject<HTMLButtonElement | null>;
	readonly children: string;
	readonly onClick: () => void;
}) {
	return (
		<button ref={buttonRef} className={`context-item${active ? " selected" : ""}`} type="button" aria-pressed={active} title={children} onClick={onClick}>
			{children}
		</button>
	);
}

function ContextFilter({ label, value, onChange }: { readonly label: string; readonly value: string; readonly onChange: (value: string) => void }) {
	const t = S[useLang()];
	return (
		<label className="context-filter">
			<Icon name="search" size={14} />
			<span className="visually-hidden">{label}</span>
			<input type="search" aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} placeholder={t.search} />
		</label>
	);
}

function ContextActions({ onDelete, onEdit }: { readonly onDelete: () => void; readonly onEdit: () => void }) {
	const t = S[useLang()];
	return (
		<span className="context-actions">
			<button className="icon-button quiet" type="button" aria-label={t.edit} onClick={onEdit}>
				<Icon name="edit" size={15} />
			</button>
			<button className="icon-button quiet danger" type="button" aria-label={t.delete} onClick={onDelete}>
				<Icon name="trash" size={15} />
			</button>
		</span>
	);
}

export function StudioChrome(props: StudioChromeProps) {
	const t = S[useLang()];
	const { selected } = props;
	const [projectQuery, setProjectQuery] = useState("");
	const [sheetQuery, setSheetQuery] = useState("");
	const activeProjectRef = useRef<HTMLButtonElement>(null);
	const activeSheetRef = useRef<HTMLButtonElement>(null);
	const visibleProjects = useMemo(() => props.projects.filter((project) => project.name.toLocaleLowerCase().includes(projectQuery.trim().toLocaleLowerCase())), [projectQuery, props.projects]);
	const visibleSheets = useMemo(() => (selected?.sheets ?? []).filter((sheet) => sheet.name.toLocaleLowerCase().includes(sheetQuery.trim().toLocaleLowerCase())), [selected, sheetQuery]);

	useEffect(() => {
		revealContextItem(activeProjectRef.current);
		setSheetQuery("");
	}, [props.selectedProjectId]);
	useEffect(() => {
		revealContextItem(activeSheetRef.current);
	}, [props.selectedSheetId]);
	return (
		<>
			<a className="skip-link" href="#workspace-main">{t.skipLink}</a>
			<header className="app-header">
				<button className="brand-lockup" type="button" aria-label={t.brandAria} title={t.brandTitle} onClick={props.onHome}>
					<img className="brand-mark" src="/logo-mark.png" alt="" aria-hidden="true" width={40} height={40} decoding="async" />
					<span><b>test-osterone</b><small>Studio</small></span>
				</button>
				<div className="header-actions">
					<LangToggle />
					<button
						className={`model-status${props.connected ? " connected" : ""}`}
						type="button"
						aria-label={props.modelLabel}
						onClick={props.onModelOpen}
					>
						<span className="status-pulse" aria-hidden="true" />
						<Icon name="model" />
						<span>{props.modelLabel}</span>
					</button>
				</div>
			</header>

			{Boolean(props.selectedProjectId) && (
			<section className="workspace-strip" aria-label={t.workspaceAria}>
				<div className="context-lane project-lane">
					<span className="context-label"><Icon name="project" />{t.project}</span>
					{props.projects.length > 8 && <ContextFilter label={t.projectSearchAria} value={projectQuery} onChange={setProjectQuery} />}
					<div className="context-reel">
						{visibleProjects.map((project) => (
							<span className="context-group" key={project.id}>
								<ContextItem active={project.id === props.selectedProjectId} buttonRef={project.id === props.selectedProjectId ? activeProjectRef : undefined} onClick={() => props.onSelectProject(project.id)}>
									{project.name}
								</ContextItem>
								{project.id === props.selectedProjectId && project.id !== "sample" && (
									<ContextActions onEdit={() => props.onEditProject(project)} onDelete={() => props.onDeleteProject(project.id)} />
								)}
							</span>
						))}
					</div>
					<button className="icon-button context-add" type="button" aria-label={t.addProjectAria} onClick={props.onAddProject}>
						<Icon name="add" />
					</button>
				</div>

				<div className="context-lane sheet-lane">
					<span className="context-label"><Icon name="sheet" />{t.sheet}</span>
					{(selected?.sheets.length ?? 0) > 8 && <ContextFilter label={t.sheetSearchAria} value={sheetQuery} onChange={setSheetQuery} />}
					<div className="context-reel">
						{visibleSheets.length ? visibleSheets.map((sheet) => (
							<span className="context-group" key={sheet.id}>
								<ContextItem active={sheet.id === props.selectedSheetId} buttonRef={sheet.id === props.selectedSheetId ? activeSheetRef : undefined} onClick={() => props.onSelectSheet(sheet.id)}>
									{sheet.name}
								</ContextItem>
								{sheet.id === props.selectedSheetId && selected?.id !== "sample" && (
									<ContextActions onEdit={() => props.onEditSheet(sheet)} onDelete={() => props.onRemoveSheet(sheet.id)} />
								)}
							</span>
						)) : <span className="context-empty">{sheetQuery ? t.noResults : t.noSheets}</span>}
					</div>
					<button
						className="icon-button context-add"
						type="button"
						aria-label={t.importSheetsAria}
						title={selected?.id === "sample" ? t.sampleNoSheetAdd : t.importSheetsAria}
						disabled={!selected || selected.id === "sample"}
						onClick={props.onImportSheets}
					>
						<Icon name="import" />
					</button>
					<button
						className="icon-button context-add"
						type="button"
						aria-label={t.addSheetAria}
						title={selected?.id === "sample" ? t.sampleNoSheetAdd : t.addSheetAria}
						disabled={!selected || selected.id === "sample"}
						onClick={props.onAddSheet}
					>
						<Icon name="add" />
					</button>
				</div>
			</section>
			)}
			{props.selectedSheetId && (
				<nav className="view-rail" aria-label={t.viewRailAria}>
					{NAV_ITEMS.map((item) => (
						<button
							key={item.tab}
							className={`view-item${props.tab === item.tab ? " active" : ""}`}
							type="button"
							aria-current={props.tab === item.tab ? "page" : undefined}
							onClick={() => props.onTabChange(item.tab)}
						>
							<Icon name={item.icon} />
							<span className="view-item-label">{t.nav[item.tab]}</span>
							{item.tab === "review" && props.navReviewCount > 0 && <b className="nav-count">{props.navReviewCount}</b>}
						</button>
					))}
				</nav>
			)}
		</>
	);
}
