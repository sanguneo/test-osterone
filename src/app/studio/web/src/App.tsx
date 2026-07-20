import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { DashboardPanel } from "./components/DashboardPanel";
import { ModelPanel } from "./components/ModelPanel";
import { ProjectsPanel } from "./components/ProjectsPanel";
import { ReviewPanel } from "./components/ReviewPanel";
import { RulesPanel } from "./components/RulesPanel";
import { RunPanel } from "./components/RunPanel";
import type { Project, Status } from "./types";

type Tab = "model" | "dash" | "projects" | "rules" | "run" | "review";

export function App() {
	const [projects, setProjects] = useState<Project[]>([]);
	const [selId, setSelId] = useState("sample");
	const [status, setStatus] = useState<Status | null>(null);
	const [tab, setTab] = useState<Tab>("dash");
	const [reviewCount, setReviewCount] = useState(0);
	const [projErr, setProjErr] = useState("");
	const [statusStale, setStatusStale] = useState(false);
	const [runSeq, setRunSeq] = useState(0);

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

	const selected = useMemo(() => projects.find((p) => p.id === selId) ?? projects[0], [projects, selId]);
	const connected = !!status?.connected;

	return (
		<>
			<header>
				<h1>
					test-osterone <span style={{ color: "var(--lime)" }}>Studio</span>
				</h1>
				<span className="tag">AI가 쓰고, 결정적 엔진이 판정합니다 — 터미널 없이</span>
			</header>
			<div className="layout">
				<nav className="side" aria-label="주 메뉴">
					<button
						type="button"
						className={`global${tab === "model" ? " on" : ""}`}
						aria-current={tab === "model" ? "page" : undefined}
						onClick={() => setTab("model")}
					>
						모델 연결{" "}
					<span
						style={{ float: "right", color: statusStale ? "var(--review)" : connected ? "var(--lime)" : "var(--dim)" }}
						title={statusStale ? "연결 상태를 확인할 수 없습니다 — 서버 응답 없음" : connected ? "모델 연결됨" : "모델 미연결"}
					>
						●
					</span>
					</button>
					<div className="side-sep">현재 프로젝트</div>
					<select className="side-select" value={selId} onChange={(e) => setSelId(e.target.value)}>
						{projects.map((p) => (
							<option key={p.id} value={p.id}>
								{p.name}
							</option>
						))}
					</select>
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
						className={tab === "projects" ? "on" : ""}
						aria-current={tab === "projects" ? "page" : undefined}
						onClick={() => setTab("projects")}
					>
						1 · 프로젝트 정보
					</button>
					<button
						type="button"
						className={tab === "rules" ? "on" : ""}
						aria-current={tab === "rules" ? "page" : undefined}
						onClick={() => setTab("rules")}
					>
						2 · 규칙·해석
					</button>
					<button
						type="button"
						className={tab === "run" ? "on" : ""}
						aria-current={tab === "run" ? "page" : undefined}
						onClick={() => setTab("run")}
					>
						3 · 실행 & 결과
					</button>
					<button
						type="button"
						className={tab === "review" ? "on" : ""}
						aria-current={tab === "review" ? "page" : undefined}
						onClick={() => setTab("review")}
					>
						4 · 리뷰 큐
						{reviewCount > 0 && <span style={{ float: "right", color: "var(--review)" }}>· {reviewCount}</span>}
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
						<DashboardPanel selId={selId} project={selected} reviewCount={reviewCount} goTo={setTab} refreshKey={runSeq} />
					</div>
					<div hidden={tab !== "model"}>
						<ModelPanel status={status} selId={selId} onStatus={setStatus} />
					</div>
					<div hidden={tab !== "projects"}>
						<ProjectsPanel projects={projects} selId={selId} setSelId={setSelId} setProjects={setProjects} />
					</div>
					<div hidden={tab !== "rules"}>
						<RulesPanel
							status={status}
							selId={selId}
							project={selected}
							connected={connected}
							onStatus={setStatus}
							goToModel={() => setTab("model")}
						/>
					</div>
					<div hidden={tab !== "run"}>
						<RunPanel project={selected} selId={selId} onDone={onRunDone} />
					</div>
					<div hidden={tab !== "review"}>
						<ReviewPanel selId={selId} onCount={setReviewCount} refreshKey={runSeq} />
					</div>
				</div>
			</div>
		</>
	);
}
