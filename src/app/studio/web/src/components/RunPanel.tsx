import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { CaseView, PreviewResult, Project, Verdict } from "../types";
import { Icon } from "./Icon";
import { RunResults, type RunViewLike } from "./RunResults";

function PreviewTable({ preview }: { readonly preview: PreviewResult }) {
	if (preview.unique.length === 0) {
		return <div className="card muted">읽을 케이스가 없습니다. 프로젝트에 TC 소스를 추가한 뒤 다시 확인하세요.</div>;
	}
	return (
		<div className="card preview-surface">
			<div className="summary">
				<b>실행 대상</b>
				<span className="chip">고유 <b>{preview.counts.unique}</b></span>
				<span className="chip review-chip">중복 <b>{preview.counts.duplicates}</b></span>
			</div>
			<div className="tscroll">
				<table>
					<thead><tr><th>제목</th><th>스텝</th><th>기대결과</th></tr></thead>
					<tbody>
						{preview.unique.slice(0, 30).map((testCase) => (
							<tr key={testCase.caseId}>
								<td>{testCase.title || testCase.caseId}</td>
								<td className="detail">{testCase.steps.join(" · ")}</td>
								<td className="detail">{testCase.expected}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{preview.unique.length > 30 && <p className="table-foot">외 {preview.unique.length - 30}개 케이스 — 실행 시 전체가 수행됩니다.</p>}
		</div>
	);
}

function RunRail({ done, live, running }: { readonly done: boolean; readonly live: boolean; readonly running: boolean }) {
	return (
		<ol className="run-rail" aria-label="실행 단계">
			<li className={`rail-step ${live ? "complete" : "active"}`}><span className="rail-node">{live ? <Icon name="check" size={15} /> : "1"}</span><div><b>케이스 준비</b><p>대상과 해석 방식을 확인합니다.</p></div></li>
			<li className={`rail-step ${done ? "complete" : running || live ? "active" : ""}`}><span className="rail-node">{done ? <Icon name="check" size={15} /> : "2"}</span><div><b>브라우저 실행</b><p>각 케이스를 순서대로 검증합니다.</p></div></li>
			<li className={`rail-step ${done ? "active" : ""}`}><span className="rail-node">3</span><div><b>증거 검토</b><p>결과와 판정 근거를 확인합니다.</p></div></li>
		</ol>
	);
}

export function RunPanel({ project, selId, selSheetId, onDone }: { readonly project?: Project; readonly selId: string; readonly selSheetId: string; readonly onDone: () => void }) {
	const [ai, setAi] = useState(false);
	const [preview, setPreview] = useState<PreviewResult | null>(null);
	const [previewError, setPreviewError] = useState("");
	const [previewLoading, setPreviewLoading] = useState(false);
	const [running, setRunning] = useState(false);
	const [statusMessage, setStatusMessage] = useState("");
	const [live, setLive] = useState<RunViewLike | null>(null);
	const [total, setTotal] = useState(0);
	const [runError, setRunError] = useState("");
	const [done, setDone] = useState(false);
	const previewController = useRef<AbortController | null>(null);
	const runController = useRef<AbortController | null>(null);
	const sheet = useMemo(() => project?.sheets.find((item) => item.id === selSheetId) ?? project?.sheets[0], [project, selSheetId]);

	useEffect(() => setAi(Boolean(project?.aiInterpret)), [project]);
	const loadPreview = useCallback(() => {
		if (!project) return;
		previewController.current?.abort();
		const controller = new AbortController();
		previewController.current = controller;
		setPreview(null);
		setPreviewError("");
		setPreviewLoading(true);
		api.preview({ sample: project.id === "sample", sheets: sheet ? [sheet] : [], sheetId: sheet?.id, baseUrl: project.baseUrl, projectId: selId }, controller.signal)
			.then((result) => { if (!controller.signal.aborted) setPreview(result); })
			.catch((error) => { if (!controller.signal.aborted) setPreviewError((error as Error).message); })
			.finally(() => { if (previewController.current === controller) { previewController.current = null; setPreviewLoading(false); } });
	}, [project, selId, sheet]);
	useEffect(() => {
		loadPreview();
		return () => previewController.current?.abort();
	}, [loadPreview]);
	useEffect(() => () => {
		previewController.current?.abort();
		runController.current?.abort();
	}, []);

	async function startRun() {
		if (!project) return;
		runController.current?.abort();
		const controller = new AbortController();
		runController.current = controller;
		setRunning(true);
		setRunError("");
		setDone(false);
		const counts: Record<Verdict, number> = { pass: 0, fail: 0, needs_review: 0, error: 0 };
		const results: CaseView[] = [];
		setLive({ baseUrl: project.baseUrl, interpreter: ai ? "ai" : "rule", counts: { ...counts }, results: [] });
		try {
			await api.runStream({ sample: project.id === "sample", sheets: sheet ? [sheet] : [], sheetId: sheet?.id, aiInterpret: ai, baseUrl: project.baseUrl, env: project.env, username: project.username, password: project.password, referenceRepo: project.referenceRepo, projectId: selId }, (event) => {
				if (controller.signal.aborted) return;
				if (event.type === "start") { setTotal(event.total); setStatusMessage(`실행 중… 0/${event.total}`); }
				else if (event.type === "case") {
					results.push(event.result);
					counts[event.result.verdict] = (counts[event.result.verdict] || 0) + 1;
					setStatusMessage(`실행 중… ${results.length}/${event.total}`);
					setLive({ baseUrl: project.baseUrl, interpreter: ai ? "ai" : "rule", counts: { ...counts }, results: [...results] });
				} else if (event.type === "done") { setStatusMessage("완료"); setDone(true); setLive(event.view); onDone(); }
				else if (event.type === "error") throw new Error(event.error);
			}, controller.signal);
		} catch (error) {
			if (!controller.signal.aborted) {
				setStatusMessage("");
				setRunError((error as Error).message);
			}
		} finally {
			if (runController.current === controller) {
				runController.current = null;
				setRunning(false);
			}
		}
	}

	if (!project) return <section><h2 className="sec">실행 & 결과</h2><div className="muted">프로젝트가 없습니다.</div></section>;

	return (
		<section>
			<div className="dash-head">
				<div><p className="kicker">Deterministic run</p><h2 className="sec">실행 작업대</h2></div>
				<span className="ctx">{project.name} · {sheet?.name ?? "시트 선택 안됨"}</span>
			</div>
			<div className="run-workbench">
				<RunRail done={done} live={Boolean(live)} running={running} />
				<div className="run-stage">
					<div className="card run-config">
						<p className="kicker">01 / Configure</p>
						<h3>실행 준비</h3>
						<p className="run-target">대상: {project.baseUrl || (project.id === "sample" ? "번들 fixture" : "대상 미설정")}<br />시트: {sheet?.name ?? "선택 안됨"}</p>
						<label className="run-toggle"><input type="checkbox" checked={ai} onChange={(event) => setAi(event.target.checked)} /><span>AI 스텝 해석<br /><small className="muted">자연어 스텝에만 사용하며 모델 연결이 필요합니다.</small></span></label>
						<div className="run-actions"><button className="button primary" type="button" disabled={running} onClick={startRun}><Icon name="play" />{running ? "실행 중" : "실행 시작"}</button><span className="muted" aria-live="polite">{statusMessage}</span></div>
					</div>
					{previewError && <div className="card err">케이스 미리보기 실패: {previewError} <button className="mini" type="button" onClick={loadPreview}>다시 시도</button></div>}
					{!live && previewLoading && <div className="card late">{[0, 1, 2].map((index) => <div className="skel" style={{ height: 18, marginTop: index === 0 ? 0 : 12 }} key={index} />)}</div>}
					{!live && preview && <PreviewTable preview={preview} />}
					{runError && <div className="card err" role="alert">오류: {runError}</div>}
					{live && <RunResults view={live} total={done ? undefined : total} />}
				</div>
			</div>
		</section>
	);
}
