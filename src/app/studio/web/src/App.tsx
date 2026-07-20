import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { ModelPanel } from "./components/ModelPanel";
import { ProjectsPanel } from "./components/ProjectsPanel";
import { ReviewPanel } from "./components/ReviewPanel";
import { RulesPanel } from "./components/RulesPanel";
import { RunPanel } from "./components/RunPanel";
import type { Project, Status } from "./types";

type Tab = "model" | "projects" | "rules" | "run" | "review";

export function App() {
	const [projects, setProjects] = useState<Project[]>([]);
	const [selId, setSelId] = useState("sample");
	const [status, setStatus] = useState<Status | null>(null);
	const [tab, setTab] = useState<Tab>("projects");
	const [reviewCount, setReviewCount] = useState(0);

	const refreshStatus = useCallback(() => {
		api.status(selId).then(setStatus).catch(() => {});
	}, [selId]);
	const refreshReview = useCallback(() => {
		api.reviewQueue(selId).then((q) => setReviewCount(q.length)).catch(() => {});
	}, [selId]);

	useEffect(() => {
		api.projects().then(setProjects).catch(() => {});
	}, []);
	useEffect(() => {
		refreshStatus();
		refreshReview();
	}, [refreshStatus, refreshReview]);

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
				<nav className="side">
					<button type="button" className={`global${tab === "model" ? " on" : ""}`} onClick={() => setTab("model")}>
						모델 연결 <span style={{ float: "right", color: connected ? "var(--lime)" : "var(--dim)" }}>●</span>
					</button>
					<div className="side-sep">현재 프로젝트</div>
					<select className="side-select" value={selId} onChange={(e) => setSelId(e.target.value)}>
						{projects.map((p) => (
							<option key={p.id} value={p.id}>
								{p.name}
							</option>
						))}
					</select>
					<button type="button" className={tab === "projects" ? "on" : ""} onClick={() => setTab("projects")}>
						1 · 프로젝트 정보
					</button>
					<button type="button" className={tab === "rules" ? "on" : ""} onClick={() => setTab("rules")}>
						2 · 규칙·해석
					</button>
					<button type="button" className={tab === "run" ? "on" : ""} onClick={() => setTab("run")}>
						3 · 실행 & 결과
					</button>
					<button type="button" className={tab === "review" ? "on" : ""} onClick={() => setTab("review")}>
						4 · 리뷰 큐
						{reviewCount > 0 && <span style={{ float: "right", color: "var(--review)" }}>· {reviewCount}</span>}
					</button>
				</nav>
				<div className="content">
					{tab === "model" && <ModelPanel status={status} selId={selId} onStatus={setStatus} />}
					{tab === "projects" && (
						<ProjectsPanel projects={projects} selId={selId} setSelId={setSelId} setProjects={setProjects} />
					)}
					{tab === "rules" && (
						<RulesPanel status={status} selId={selId} project={selected} connected={connected} onStatus={setStatus} />
					)}
					{tab === "run" && <RunPanel project={selected} selId={selId} onDone={refreshReview} />}
					{tab === "review" && <ReviewPanel selId={selId} onCount={setReviewCount} />}
				</div>
			</div>
		</>
	);
}
