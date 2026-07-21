import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Project, TestSheet } from "../types";
import { Icon, type IconName } from "./Icon";

export type StudioTab = "dash" | "rules" | "run" | "review";

interface StudioChromeProps {
	readonly connected: boolean;
	readonly modelLabel: string;
	readonly modelStale: boolean;
	readonly navReviewCount: number;
	readonly onAddProject: () => void;
	readonly onAddSheet: () => void;
	readonly onDeleteProject: (id: string) => void;
	readonly onEditProject: (project: Project) => void;
	readonly onEditSheet: (sheet: TestSheet) => void;
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

const NAV_ITEMS: ReadonlyArray<{ icon: IconName; label: string; shortLabel: string; tab: StudioTab }> = [
	{ icon: "overview", label: "대시보드", shortLabel: "현황", tab: "dash" },
	{ icon: "rules", label: "규칙·해석", shortLabel: "규칙", tab: "rules" },
	{ icon: "play", label: "실행 & 결과", shortLabel: "실행", tab: "run" },
	{ icon: "review", label: "리뷰 큐", shortLabel: "리뷰", tab: "review" },
];

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
	return (
		<label className="context-filter">
			<Icon name="search" size={14} />
			<span className="visually-hidden">{label}</span>
			<input type="search" aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} placeholder="검색" />
		</label>
	);
}

function ContextActions({ onDelete, onEdit }: { readonly onDelete: () => void; readonly onEdit: () => void }) {
	return (
		<span className="context-actions">
			<button className="icon-button quiet" type="button" aria-label="편집" onClick={onEdit}>
				<Icon name="edit" size={15} />
			</button>
			<button className="icon-button quiet danger" type="button" aria-label="삭제" onClick={onDelete}>
				<Icon name="trash" size={15} />
			</button>
		</span>
	);
}

export function StudioChrome(props: StudioChromeProps) {
	const { selected } = props;
	const [projectQuery, setProjectQuery] = useState("");
	const [sheetQuery, setSheetQuery] = useState("");
	const activeProjectRef = useRef<HTMLButtonElement>(null);
	const activeSheetRef = useRef<HTMLButtonElement>(null);
	const visibleProjects = useMemo(() => props.projects.filter((project) => project.name.toLocaleLowerCase().includes(projectQuery.trim().toLocaleLowerCase())), [projectQuery, props.projects]);
	const visibleSheets = useMemo(() => (selected?.sheets ?? []).filter((sheet) => sheet.name.toLocaleLowerCase().includes(sheetQuery.trim().toLocaleLowerCase())), [selected, sheetQuery]);

	useEffect(() => {
		activeProjectRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [props.selectedProjectId]);
	useEffect(() => {
		activeSheetRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [props.selectedSheetId]);
	return (
		<>
			<a className="skip-link" href="#workspace-main">본문으로 건너뛰기</a>
			<header className="app-header">
				<div className="brand-lockup" aria-label="test-osterone Studio">
					<span className="brand-mark" aria-hidden="true">t</span>
					<span><b>test-osterone</b><small>Studio</small></span>
				</div>
				<nav className="primary-nav" aria-label="주 메뉴">
					{NAV_ITEMS.map((item) => (
						<button
							key={item.tab}
							className={`nav-item${props.tab === item.tab ? " active" : ""}`}
							type="button"
							aria-current={props.tab === item.tab ? "page" : undefined}
							onClick={() => props.onTabChange(item.tab)}
						>
							<Icon name={item.icon} />
							<span className="nav-label">{item.label}</span>
							<span className="nav-short-label">{item.shortLabel}</span>
							{item.tab === "review" && props.navReviewCount > 0 && <b className="nav-count">{props.navReviewCount}</b>}
						</button>
					))}
				</nav>
				<button
					className={`model-status${props.connected ? " connected" : ""}${props.modelStale ? " stale" : ""}`}
					type="button"
					aria-label={props.modelLabel}
					onClick={props.onModelOpen}
				>
					<span className="status-pulse" aria-hidden="true" />
					<Icon name="model" />
					<span>{props.modelLabel}</span>
				</button>
			</header>

			<section className="workspace-strip" aria-label="작업 컨텍스트">
				<div className="context-lane project-lane">
					<span className="context-label"><Icon name="project" />프로젝트</span>
					{props.projects.length > 8 && <ContextFilter label="프로젝트 검색" value={projectQuery} onChange={setProjectQuery} />}
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
					<button className="icon-button context-add" type="button" aria-label="프로젝트 추가" onClick={props.onAddProject}>
						<Icon name="add" />
					</button>
				</div>

				<div className="context-lane sheet-lane">
					<span className="context-label"><Icon name="sheet" />시트</span>
					{(selected?.sheets.length ?? 0) > 8 && <ContextFilter label="시트 검색" value={sheetQuery} onChange={setSheetQuery} />}
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
						)) : <span className="context-empty">{sheetQuery ? "검색 결과 없음" : "연결된 시트 없음"}</span>}
					</div>
					<button
						className="icon-button context-add"
						type="button"
						aria-label="시트 추가"
						disabled={!selected || selected.id === "sample"}
						onClick={props.onAddSheet}
					>
						<Icon name="add" />
					</button>
				</div>
			</section>
		</>
	);
}
