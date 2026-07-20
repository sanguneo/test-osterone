import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { CaseView, PreviewResult, Project, Verdict } from "../types";
import { SelfHealNote, stripAnsi, VerdictCounts, VerdictMark } from "./Verdict";

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
				<VerdictCounts counts={c} />
			</div>
			<div className="tscroll">
				<table>
					<thead>
						<tr>
							<th>케이스</th>
							<th>판정</th>
							<th className="num">신뢰도</th>
							<th className="num">Assert</th>
							<th>상세</th>
						</tr>
					</thead>
					<tbody>
						{view.results.map((r) => (
							<tr key={r.caseId}>
								<td>{r.title}</td>
								<td>
									<VerdictMark verdict={r.verdict} />
								</td>
								<td className="num">{r.confidence.toFixed(2)}</td>
								<td className="num">
									{r.passed}/{r.total}
								</td>
								<td>
									{r.assertions.map((a, i) => (
										<div className="detail" key={i}>
											<span className={a.passed ? "o" : "x"}>{a.passed ? "✓" : "✗"}</span> {stripAnsi(a.detail)}
										</div>
									))}
									<SelfHealNote heal={r.heal} />
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

export function RunPanel({
	project,
	selId,
	selSheetId,
	onDone,
}: { project?: Project; selId: string; selSheetId: string; onDone: () => void }) {
	const [ai, setAi] = useState(false);
	const [preview, setPreview] = useState<PreviewResult | null>(null);
	const [previewErr, setPreviewErr] = useState("");
	const [running, setRunning] = useState(false);
	const [statusMsg, setStatusMsg] = useState("");
	const [live, setLive] = useState<ViewLike | null>(null);
	const [total, setTotal] = useState(0);
	const [runErr, setRunErr] = useState("");
	const [done, setDone] = useState(false);

	const sheet = useMemo(() => project?.sheets.find((s) => s.id === selSheetId) ?? project?.sheets[0], [project, selSheetId]);
	useEffect(() => {
		setAi(!!project?.aiInterpret);
	}, [project]);

	const [previewLoading, setPreviewLoading] = useState(false);
	const loadPreview = useCallback(() => {
		if (!project) return;
		setPreview(null);
		setPreviewErr("");
		setPreviewLoading(true);
		api
			.preview({ sample: project.id === "sample", sheets: sheet ? [sheet] : [], sheetId: sheet?.id, baseUrl: project.baseUrl, projectId: selId })
			.then(setPreview)
			.catch((e) => setPreviewErr((e as Error).message))
			.finally(() => setPreviewLoading(false));
	}, [project, selId, sheet]);
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
					sheets: sheet ? [sheet] : [],
					sheetId: sheet?.id,
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
					대상: {project.baseUrl || (project.id === "sample" ? "번들 fixture" : "대상 미설정")} · 시트: {sheet?.name ?? "(선택 안됨)"}
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
			{previewErr && (
				<div className="card err">
					케이스 미리보기 실패: {previewErr}{" "}
					<button className="mini" type="button" onClick={loadPreview} style={{ marginLeft: 8 }}>
						다시 시도
					</button>
				</div>
			)}
			{!live && previewLoading && (
				<div className="card late">
					{[0, 1, 2].map((i) => (
						<div className="skel" style={{ height: 18, marginTop: i === 0 ? 0 : 12 }} key={i} />
					))}
				</div>
			)}
			{!live && preview && preview.unique.length === 0 && (
				<div className="card muted">
					읽을 케이스가 없습니다. 1 · 프로젝트 정보 탭에서 TC 소스(시트·CSV·XLSX)를 추가한 뒤 다시 확인하세요.
				</div>
			)}
			{!live && preview && preview.unique.length > 0 && (
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
					<div className="tscroll">
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
					{preview.unique.length > 30 && (
						<div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
							외 {preview.unique.length - 30}개 케이스 — 실행 시 전체 {preview.unique.length}개가 수행됩니다.
						</div>
					)}
				</div>
			)}
			{runErr && <div className="card err">오류: {runErr}</div>}
			{live && <ResultCard view={live} total={done ? undefined : total} />}
		</section>
	);
}
