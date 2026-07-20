import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { CaseView, PreviewResult, Project, Verdict } from "../types";

interface ViewLike {
	baseUrl: string;
	interpreter: "ai" | "rule";
	counts: Record<Verdict, number>;
	results: CaseView[];
}

function ResultCard({ view, total }: { view: ViewLike; total?: number }) {
	const c = view.counts;
	return (
		<div className="card">
			<div className="summary">
				{total !== undefined && total > view.results.length ? (
					<b>
						진행 {view.results.length}/{total}
					</b>
				) : (
					<span className="chip">
						해석 <b>{view.interpreter === "ai" ? "AI" : "규칙"}</b>
					</span>
				)}
				<span className="chip" style={{ color: "var(--pass)" }}>
					pass <b>{c.pass || 0}</b>
				</span>
				<span className="chip" style={{ color: "var(--fail)" }}>
					fail <b>{c.fail || 0}</b>
				</span>
				<span className="chip" style={{ color: "var(--review)" }}>
					needs_review <b>{c.needs_review || 0}</b>
				</span>
				<span className="chip" style={{ color: "var(--error)" }}>
					error <b>{c.error || 0}</b>
				</span>
			</div>
			<table>
				<thead>
					<tr>
						<th>케이스</th>
						<th>판정</th>
						<th>신뢰도</th>
						<th>assert</th>
						<th>상세</th>
					</tr>
				</thead>
				<tbody>
					{view.results.map((r) => (
						<tr key={r.caseId}>
							<td>{r.title}</td>
							<td>
								<span className={`badge v-${r.verdict}`}>{r.verdict}</span>
							</td>
							<td>{r.confidence.toFixed(2)}</td>
							<td>
								{r.passed}/{r.total}
							</td>
							<td>
								{r.assertions.map((a, i) => (
									<div className="detail" key={i}>
										<span className={a.passed ? "o" : "x"}>{a.passed ? "✓" : "✗"}</span> {a.detail}
									</div>
								))}
								{r.heal.length > 0 && <div className="heal">⚠ self-heal: {r.heal.join("; ")}</div>}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export function RunPanel({ project, selId, onDone }: { project?: Project; selId: string; onDone: () => void }) {
	const [ai, setAi] = useState(false);
	const [preview, setPreview] = useState<PreviewResult | null>(null);
	const [previewErr, setPreviewErr] = useState("");
	const [running, setRunning] = useState(false);
	const [statusMsg, setStatusMsg] = useState("");
	const [live, setLive] = useState<ViewLike | null>(null);
	const [total, setTotal] = useState(0);
	const [runErr, setRunErr] = useState("");
	const [done, setDone] = useState(false);

	useEffect(() => {
		setAi(!!project?.aiInterpret);
	}, [project]);

	const loadPreview = useCallback(() => {
		if (!project) return;
		setPreview(null);
		setPreviewErr("");
		api
			.preview({ sample: project.id === "sample", sources: project.sources, baseUrl: project.baseUrl, projectId: selId })
			.then(setPreview)
			.catch((e) => setPreviewErr((e as Error).message));
	}, [project, selId]);
	useEffect(loadPreview, [loadPreview]);

	async function run() {
		if (!project) return;
		setRunning(true);
		setRunErr("");
		setDone(false);
		const counts: Record<Verdict, number> = { pass: 0, fail: 0, needs_review: 0, error: 0 };
		const results: CaseView[] = [];
		setLive({ baseUrl: project.baseUrl, interpreter: ai ? "ai" : "rule", counts: { ...counts }, results: [] });
		try {
			await api.runStream(
				{
					sample: project.id === "sample",
					sources: project.sources,
					aiInterpret: ai,
					baseUrl: project.baseUrl,
					env: project.env,
					username: project.username,
					password: project.password,
					referenceRepo: project.referenceRepo,
					projectId: selId,
				},
				(ev) => {
					if (ev.type === "start") {
						setTotal(ev.total);
						setStatusMsg(`실행 중… 0/${ev.total}`);
					} else if (ev.type === "case") {
						results.push(ev.result);
						counts[ev.result.verdict] = (counts[ev.result.verdict] || 0) + 1;
						setStatusMsg(`실행 중… ${results.length}/${ev.total}`);
						setLive({ baseUrl: project.baseUrl, interpreter: ai ? "ai" : "rule", counts: { ...counts }, results: [...results] });
					} else if (ev.type === "done") {
						setStatusMsg("완료");
						setDone(true);
						setLive(ev.view);
						onDone();
					} else if (ev.type === "error") {
						throw new Error(ev.error);
					}
				},
			);
		} catch (e) {
			setStatusMsg("");
			setRunErr((e as Error).message);
		} finally {
			setRunning(false);
		}
	}

	if (!project)
		return (
			<section>
				<h2 className="sec">실행 & 결과</h2>
				<div className="muted">프로젝트가 없습니다.</div>
			</section>
		);

	return (
		<section>
			<h2 className="sec">실행 & 결과</h2>
			<div className="card">
				<div className="muted" style={{ fontSize: 12.5 }}>
					대상: {project.baseUrl || (project.id === "sample" ? "번들 fixture" : "대상 미설정")} · 소스 {project.sources.length}개
				</div>
				<label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, cursor: "pointer" }}>
					<input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} />{" "}
					<span>
						AI 스텝 해석 <span className="muted">— 따옴표 없는 자연어 (모델 연결 필요)</span>
					</span>
				</label>
				<div style={{ marginTop: 14 }}>
					<button className="run" style={{ marginTop: 0 }} type="button" disabled={running} onClick={run}>
						{running ? "실행 중…" : "실행"}
					</button>
					<span className="muted" style={{ marginLeft: 12 }}>
						{statusMsg}
					</span>
				</div>
			</div>
			{previewErr && <div className="card err">케이스 미리보기 실패: {previewErr}</div>}
			{!live && preview && (
				<div className="card">
					<div className="summary">
						<b>실행 대상 케이스</b>
						<span className="chip">
							고유 <b>{preview.counts.unique}</b>
						</span>
						<span className="chip" style={{ color: "var(--review)" }}>
							중복 <b>{preview.counts.duplicates}</b>
						</span>
					</div>
					<table>
						<thead>
							<tr>
								<th>제목</th>
								<th>스텝</th>
								<th>기대결과</th>
							</tr>
						</thead>
						<tbody>
							{preview.unique.slice(0, 30).map((cse) => (
								<tr key={cse.caseId}>
									<td>{cse.title || cse.caseId}</td>
									<td className="detail">{cse.steps.join(" · ")}</td>
									<td className="detail">{cse.expected}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{runErr && <div className="card err">오류: {runErr}</div>}
			{live && <ResultCard view={live} total={done ? undefined : total} />}
		</section>
	);
}
