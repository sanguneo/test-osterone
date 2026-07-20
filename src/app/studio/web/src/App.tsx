import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { DashboardPanel } from "./components/DashboardPanel";
import { ModelPanel } from "./components/ModelPanel";
import { ProjectsPanel } from "./components/ProjectsPanel";
import { ReviewPanel } from "./components/ReviewPanel";
import { RulesPanel } from "./components/RulesPanel";
import { RunPanel } from "./components/RunPanel";
import { SheetEditorModal } from "./components/SheetEditorModal";
import type { Project, Status, TestSheet } from "./types";

type Tab = "dash" | "rules" | "run" | "review";

export function App() {
	const [projects, setProjects] = useState<Project[]>([]);
	const [selId, setSelId] = useState("sample");
	const [status, setStatus] = useState<Status | null>(null);
	const [tab, setTab] = useState<Tab>("dash");
	const [reviewCount, setReviewCount] = useState(0);
	const [navReviewCount, setNavReviewCount] = useState(0);
	const [projErr, setProjErr] = useState("");
	const [statusStale, setStatusStale] = useState(false);
	const [runSeq, setRunSeq] = useState(0);
	const [selSheetId, setSelSheetId] = useState("");
	const [modelOpen, setModelOpen] = useState(false);
	const [projectModal, setProjectModal] = useState(false);
	const [editProject, setEditProject] = useState<Project | null>(null);
	const [sheetModal, setSheetModal] = useState(false);
	const [editSheet, setEditSheet] = useState<TestSheet | null>(null);
	const [confirmDelProj, setConfirmDelProj] = useState("");
	const [projFilter, setProjFilter] = useState("");
	const [sheetFilter, setSheetFilter] = useState("");
	const projLaneRef = useRef<HTMLDivElement>(null);
	const sheetLaneRef = useRef<HTMLDivElement>(null);

	const refreshStatus = useCallback(() => {
		api
			.status(selId)
			.then((s) => {
				setStatus(s);
				setStatusStale(false);
			})
			.catch(() => setStatusStale(true));
	}, [selId]);
	const onRunDone = useCallback(() => {
		setRunSeq((n) => n + 1);
	}, []);

	const loadProjects = useCallback(() => {
		setProjErr("");
		api
			.projects()
			.then(setProjects)
			.catch((e) => setProjErr((e as Error).message));
	}, []);
	useEffect(loadProjects, [loadProjects]);
	useEffect(refreshStatus, [refreshStatus]);
	useEffect(() => {
		// Nav badge is a roll-up across every sheet, independent of which sheet ReviewPanel is showing.
		api
			.reviewQueue(selId, undefined, true)
			.then((q) => setNavReviewCount(q.length))
			.catch(() => {});
	}, [selId, runSeq, reviewCount]);

	const selected = useMemo(() => projects.find((p) => p.id === selId) ?? projects[0], [projects, selId]);
	const connected = !!status?.connected;

	useEffect(() => {
		if (!selected) return;
		if (!selected.sheets.some((s) => s.id === selSheetId)) setSelSheetId(selected.sheets[0]?.id ?? "");
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selected]);
	const shownProjects = projects.filter((p) => p.name.toLowerCase().includes(projFilter.trim().toLowerCase()));
	const shownSheets = (selected?.sheets ?? []).filter((s) => s.name.toLowerCase().includes(sheetFilter.trim().toLowerCase()));
	useEffect(() => {
		projLaneRef.current?.querySelector(".lane-item.on")?.scrollIntoView({ block: "nearest" });
	}, [selId]);
	useEffect(() => {
		sheetLaneRef.current?.querySelector(".lane-item.on")?.scrollIntoView({ block: "nearest" });
	}, [selSheetId]);

	async function delProject(id: string) {
		setConfirmDelProj("");
		try {
			const { projects: ps } = await api.deleteProject(id);
			setProjects(ps);
			if (selId === id) setSelId("sample");
		} catch (e) {
			setProjErr((e as Error).message);
		}
	}

	async function persistSheets(nextSheets: TestSheet[]) {
		if (!selected || selected.id === "sample") return;
		try {
			const { projects: ps } = await api.saveProject({
				id: selected.id,
				projectId: selected.id,
				sample: false,
				name: selected.name,
				sheets: nextSheets,
				baseUrl: selected.baseUrl,
				env: selected.env,
				username: selected.username,
				password: selected.password,
				referenceRepo: selected.referenceRepo,
				aiInterpret: selected.aiInterpret,
			});
			setProjects(ps);
		} catch (e) {
			setProjErr((e as Error).message);
		}
	}

	async function removeSheet(id: string) {
		if (!selected) return;
		await persistSheets(selected.sheets.filter((s) => s.id !== id));
		if (selSheetId === id) setSelSheetId("");
	}

	useEffect(() => {
		if (!modelOpen) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setModelOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [modelOpen]);

	return (
		<>
			<header>
				<h1>
					test-osterone <span style={{ color: "var(--lime)" }}>Studio</span>
				</h1>
				<span className="tag">AI가 쓰고, 결정적 엔진이 판정합니다 — 터미널 없이</span>
				<button
					type="button"
					className={`topbar-auth${connected ? " on" : ""}`}
					onClick={() => setModelOpen(true)}
					title={statusStale ? "연결 상태를 확인할 수 없습니다 — 서버 응답 없음" : connected ? "모델 연결됨" : "모델 미연결"}
				>
					<span className="dot" style={{ color: statusStale ? "var(--review)" : connected ? "var(--lime)" : "var(--dim)" }}>
						●
					</span>
					{connected && status?.auth ? status.auth.model : "모델 연결"}
				</button>
			</header>
			<div className="layout">
			<nav className="side" aria-label="주 메뉴">
					<div className="lane-head">
						<span>프로젝트</span>
						<button
							className="lane-add"
							type="button"
							title="새 프로젝트"
							onClick={() => {
								setEditProject(null);
								setProjectModal(true);
							}}
						>
							+
						</button>
					</div>
					{projects.length > 8 && (
						<input
							className="lane-filter"
							placeholder="프로젝트 검색"
							value={projFilter}
							onChange={(e) => setProjFilter(e.target.value)}
						/>
					)}
					<div className="side-projects" ref={projLaneRef}>
						{shownProjects.map((p) => (
							<div className={`lane-item${p.id === selId ? " on" : ""}`} key={p.id}>
								<button className="lane-item-label" type="button" title={p.name} onClick={() => setSelId(p.id)}>
									{p.name}
								</button>
								{p.id !== "sample" &&
									(confirmDelProj === p.id ? (
										<span className="lane-actions">
											<button className="mini" type="button" style={{ color: "var(--fail)" }} onClick={() => delProject(p.id)}>
												삭제
											</button>
											<button className="mini" type="button" onClick={() => setConfirmDelProj("")}>
												취소
											</button>
										</span>
									) : (
										<span className="lane-actions">
											<button
												type="button"
												title="편집"
												onClick={() => {
													setEditProject(p);
													setProjectModal(true);
												}}
											>
												✎
											</button>
											<button type="button" title="삭제" onClick={() => setConfirmDelProj(p.id)}>
												🗑
											</button>
										</span>
									))}
							</div>
						))}
					</div>
					<div className="lane-head">
						<span>시트</span>
						<button
							className="lane-add"
							type="button"
							title="새 시트"
							disabled={!selected || selected.id === "sample"}
							onClick={() => {
								setEditSheet(null);
								setSheetModal(true);
							}}
						>
							+
						</button>
					</div>
					{selected && selected.sheets.length > 8 && (
						<input
							className="lane-filter"
							placeholder="시트 검색"
							value={sheetFilter}
							onChange={(e) => setSheetFilter(e.target.value)}
						/>
					)}
					<div className="side-sheets" ref={sheetLaneRef}>
						{selected && selected.sheets.length > 0 ? (
							shownSheets.map((s) => (
								<div className={`lane-item${s.id === selSheetId ? " on" : ""}`} key={s.id}>
										<button className="lane-item-label" type="button" title={s.name} onClick={() => setSelSheetId(s.id)}>
										{s.name}
									</button>
									{selected.id !== "sample" && (
										<span className="lane-actions">
											<button
												type="button"
												title="이름/대상 편집"
												onClick={() => {
													setEditSheet(s);
													setSheetModal(true);
												}}
											>
												✎
											</button>
											<button type="button" title="제거" onClick={() => removeSheet(s.id)}>
												×
											</button>
										</span>
									)}
								</div>
							))
						) : (
							<div className="muted" style={{ fontSize: 12, padding: "4px 8px" }}>
								시트 없음 — + 로 추가
							</div>
						)}
					</div>
					<button
						type="button"
						className={tab === "dash" ? "on" : ""}
						aria-current={tab === "dash" ? "page" : undefined}
						onClick={() => setTab("dash")}
					>
						대시보드
					</button>
					<button
						type="button"
						className={tab === "rules" ? "on" : ""}
						aria-current={tab === "rules" ? "page" : undefined}
						onClick={() => setTab("rules")}
					>
						규칙·해석
					</button>
					<button
						type="button"
						className={tab === "run" ? "on" : ""}
						aria-current={tab === "run" ? "page" : undefined}
						onClick={() => setTab("run")}
					>
						실행 & 결과
					</button>
					<button
						type="button"
						className={tab === "review" ? "on" : ""}
						aria-current={tab === "review" ? "page" : undefined}
						onClick={() => setTab("review")}
					>
					리뷰 큐
					{navReviewCount > 0 && <span style={{ float: "right", color: "var(--review)" }}>· {navReviewCount}</span>}
					</button>
				</nav>
				<div className="content">
					{projErr && (
						<div className="card err">
							프로젝트 목록을 불러오지 못했습니다: {projErr}{" "}
							<button className="mini" type="button" onClick={loadProjects} style={{ marginLeft: 8 }}>
								다시 시도
							</button>
						</div>
					)}
					{/* Panels stay mounted (hidden, not unmounted) so a live run and in-progress edits survive tab switches. */}
				<div hidden={tab !== "dash"}>
					<DashboardPanel
						selId={selId}
						project={selected}
						selSheetId={selSheetId}
						reviewCount={navReviewCount}
						goTo={setTab}
						refreshKey={runSeq}
					/>
					</div>
				<div hidden={tab !== "rules"}>
					<RulesPanel
						status={status}
						selId={selId}
						project={selected}
						selSheetId={selSheetId}
						connected={connected}
						onStatus={setStatus}
						goToModel={() => setModelOpen(true)}
					/>
					</div>
					<div hidden={tab !== "run"}>
						<RunPanel project={selected} selId={selId} selSheetId={selSheetId} onDone={onRunDone} />
					</div>
					<div hidden={tab !== "review"}>
						<ReviewPanel selId={selId} selSheetId={selSheetId} onCount={setReviewCount} refreshKey={runSeq} />
					</div>
				</div>
			</div>
			{modelOpen && (
				<div
					className="modal-overlay"
					role="dialog"
					aria-modal="true"
					aria-label="모델 연결"
					onClick={(e) => {
						if (e.target === e.currentTarget) setModelOpen(false);
					}}
				>
					<div className="modal">
						<button className="modal-close" type="button" aria-label="닫기" onClick={() => setModelOpen(false)}>
							✕
						</button>
						<ModelPanel status={status} selId={selId} onStatus={setStatus} onClose={() => setModelOpen(false)} />
					</div>
				</div>
			)}
			{projectModal && (
				<div
					className="modal-overlay"
					role="dialog"
					aria-modal="true"
					aria-label="프로젝트"
					onClick={(e) => {
						if (e.target === e.currentTarget) setProjectModal(false);
					}}
				>
					<div className="modal modal-wide">
						<button className="modal-close" type="button" aria-label="닫기" onClick={() => setProjectModal(false)}>
							✕
						</button>
						<ProjectsPanel
							initialProject={editProject}
							projects={projects}
							onSaved={(savedId, ps) => {
								setProjects(ps);
								setSelId(savedId);
							}}
							onClose={() => setProjectModal(false)}
						/>
					</div>
				</div>
			)}
			{sheetModal && selected && (
				<SheetEditorModal
					editSheet={editSheet}
					projectId={selected?.id ?? ""}
					onClose={() => setSheetModal(false)}
					onSave={(sheet) => {
						const next = editSheet ? selected.sheets.map((s) => (s.id === editSheet.id ? sheet : s)) : [...selected.sheets, sheet];
						persistSheets(next);
						setSelSheetId(sheet.id);
						setSheetModal(false);
					}}
				/>
			)}
		</>
	);
}
