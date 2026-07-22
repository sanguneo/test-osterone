import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { getLang, useLang } from "../i18n";
import type { CaseView, PreviewResult, Project, Verdict } from "../types";
import { Icon } from "./Icon";
import { RunResults, type RunViewLike } from "./RunResults";
import { vLabel } from "./Verdict";

const S = {
	ko: {
		noCases: "읽을 케이스가 없습니다. 프로젝트에 테스트 원본을 추가한 뒤 다시 확인하세요.",
		runTarget: "실행 대상",
		unique: "고유",
		duplicates: "중복",
		titleCol: "제목",
		stepsCol: "스텝",
		expectedCol: "기대결과",
		moreCases: (n: number) => `외 ${n}개 케이스 — 실행 시 전체가 수행됩니다.`,
		runStepsAria: "실행 단계",
		step1Title: "케이스 준비",
		step1Sub: "대상과 해석 방식 확인",
		step2Title: "브라우저 실행",
		step2Sub: "각 케이스를 순서대로 검증합니다.",
		step3Title: "증거 검토",
		step3Sub: "결과와 판정 근거 확인",
		workbench: "실행 작업대",
		noProject: "프로젝트가 없습니다.",
		noSheetSelected: "시트 선택 안됨",
		runReady: "실행 준비",
		target: (v: string) => `대상: ${v}`,
		builtinSample: "내장 예제",
		targetUnset: "대상 미설정",
		sheet: (v: string) => `시트: ${v}`,
		sheetUnselected: "선택 안됨",
		aiInterpret: "AI 스텝 해석",
		aiInterpretHint: "자연어 스텝에만 사용하며 모델 연결이 필요합니다.",
		showBrowser: "브라우저 표시",
		showBrowserHint: "실행 과정을 볼 수 있게 창을 띄웁니다(느려짐).",
		start: "실행 시작",
		running: "실행 중",
		previewFail: (msg: string) => `케이스 미리보기 실패: ${msg}`,
		retry: "다시 시도",
		error: (msg: string) => `오류: ${msg}`,
		runningStatus: (n: number, total: number) => `실행 중… ${n}/${total}`,
		done: "완료",
		runAll: "전체 시트 실행",
		runAllTitle: "전체 시트 실행",
		sheetCol: "시트",
		statusCol: "상태",
		stPending: "대기",
		stRunning: "진행",
		stDone: "완료",
		stError: "오류",
	},
	en: {
		noCases: "No cases found. Add test sources to the project and check again.",
		runTarget: "Run target",
		unique: "Unique",
		duplicates: "Duplicates",
		titleCol: "Title",
		stepsCol: "Steps",
		expectedCol: "Expected",
		moreCases: (n: number) => `+${n} more case${n === 1 ? "" : "s"} — all will run.`,
		runStepsAria: "Run steps",
		step1Title: "Prepare cases",
		step1Sub: "Confirm target and interpretation mode",
		step2Title: "Run in browser",
		step2Sub: "Verifies each case in order.",
		step3Title: "Review evidence",
		step3Sub: "Check results and verdict rationale",
		workbench: "Run workbench",
		noProject: "No project.",
		noSheetSelected: "No sheet selected",
		runReady: "Run setup",
		target: (v: string) => `Target: ${v}`,
		builtinSample: "Built-in sample",
		targetUnset: "Target not set",
		sheet: (v: string) => `Sheet: ${v}`,
		sheetUnselected: "Not selected",
		aiInterpret: "AI step interpretation",
		aiInterpretHint: "Only used for natural-language steps; requires a connected model.",
		showBrowser: "Show browser",
		showBrowserHint: "Opens a visible window so you can watch (slower).",
		start: "Start run",
		running: "Running",
		previewFail: (msg: string) => `Case preview failed: ${msg}`,
		retry: "Retry",
		error: (msg: string) => `Error: ${msg}`,
		runningStatus: (n: number, total: number) => `Running… ${n}/${total}`,
		done: "Done",
		runAll: "Run all sheets",
		runAllTitle: "All-sheets run",
		sheetCol: "Sheet",
		statusCol: "Status",
		stPending: "Pending",
		stRunning: "Running",
		stDone: "Done",
		stError: "Error",
	},
} as const;

type SheetProg = { sheetId: string; name: string; status: "pending" | "running" | "done" | "error"; done: number; total: number; counts: Record<Verdict, number>; error?: string };
interface RunAllState { order: string[]; prog: Record<string, SheetProg> }
const VERDICTS: Verdict[] = ["pass", "fail", "needs_review", "error"];
function emptyCounts(): Record<Verdict, number> { return { pass: 0, fail: 0, needs_review: 0, error: 0 }; }

function PreviewTable({ preview }: { readonly preview: PreviewResult }) {
	const t = S[useLang()];
	if (preview.unique.length === 0) {
		return <div className="card muted">{t.noCases}</div>;
	}
	return (
		<div className="preview-surface">
			<div className="summary">
				<b>{t.runTarget}</b>
				<span className="chip">{t.unique} <b>{preview.counts.unique}</b></span>
				<span className={`chip${preview.counts.duplicates > 0 ? " review-chip" : ""}`}>{t.duplicates} <b>{preview.counts.duplicates}</b></span>
			</div>
			<div className="tscroll">
				<table>
					<thead><tr><th>{t.titleCol}</th><th>{t.stepsCol}</th><th>{t.expectedCol}</th></tr></thead>
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
			{preview.unique.length > 30 && <p className="table-foot">{t.moreCases(preview.unique.length - 30)}</p>}
		</div>
	);
}

function RunRail({ done, live, running }: { readonly done: boolean; readonly live: boolean; readonly running: boolean }) {
	const t = S[useLang()];
	return (
		<ol className="run-rail" aria-label={t.runStepsAria}>
			<li className={`rail-step ${live ? "complete" : "active"}`}><span className="rail-node">{live ? <Icon name="check" size={15} /> : "1"}</span><div><b>{t.step1Title}</b><p>{t.step1Sub}</p></div></li>
			<li className={`rail-step ${done ? "complete" : running || live ? "active" : ""}`}><span className="rail-node">{done ? <Icon name="check" size={15} /> : "2"}</span><div><b>{t.step2Title}</b><p>{t.step2Sub}</p></div></li>
			<li className={`rail-step ${done ? "active" : ""}`}><span className="rail-node">3</span><div><b>{t.step3Title}</b><p>{t.step3Sub}</p></div></li>
		</ol>
	);
}
export function RunPanel({ project, selId, selSheetId, onDone }: { readonly project?: Project; readonly selId: string; readonly selSheetId: string; readonly onDone: () => void }) {
	const [ai, setAi] = useState(false);
	const [headed, setHeaded] = useState(false);
	const [preview, setPreview] = useState<PreviewResult | null>(null);
	const [previewError, setPreviewError] = useState("");
	const [previewLoading, setPreviewLoading] = useState(false);
	const [running, setRunning] = useState(false);
	const [statusMessage, setStatusMessage] = useState("");
	const [live, setLive] = useState<RunViewLike | null>(null);
	const [total, setTotal] = useState(0);
	const [runError, setRunError] = useState("");
	const [done, setDone] = useState(false);
	const [runAll, setRunAll] = useState<RunAllState | null>(null);
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
			await api.runStream({ sample: project.id === "sample", sheets: sheet ? [sheet] : [], sheetId: sheet?.id, aiInterpret: ai, headed, baseUrl: project.baseUrl, env: project.env, username: project.username, password: project.password, referenceRepo: project.referenceRepo, projectId: selId }, (event) => {
				if (controller.signal.aborted) return;
				const t2 = S[getLang()];
				if (event.type === "start") { setTotal(event.total); setStatusMessage(t2.runningStatus(0, event.total)); }
				else if (event.type === "case") {
					results.push(event.result);
					counts[event.result.verdict] = (counts[event.result.verdict] || 0) + 1;
					setStatusMessage(t2.runningStatus(results.length, event.total));
					setLive({ baseUrl: project.baseUrl, interpreter: ai ? "ai" : "rule", counts: { ...counts }, results: [...results] });
				} else if (event.type === "done") { setStatusMessage(t2.done); setDone(true); setLive(event.view); onDone(); }
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

	async function startRunAll() {
		if (!project) return;
		const sheets = project.sheets;
		if (sheets.length === 0) return;
		runController.current?.abort();
		const controller = new AbortController();
		runController.current = controller;
		setRunning(true);
		setRunError("");
		setDone(false);
		setLive(null);
		const prog: Record<string, SheetProg> = {};
		for (const s of sheets) prog[s.id] = { sheetId: s.id, name: s.name, status: "pending", done: 0, total: 0, counts: emptyCounts() };
		const order = sheets.map((s) => s.id);
		const push = () => setRunAll({ order, prog: { ...prog } });
		push();
		try {
			await api.runAllStream({ sample: false, sheets, aiInterpret: ai, headed, baseUrl: project.baseUrl, env: project.env, username: project.username, password: project.password, referenceRepo: project.referenceRepo, projectId: selId }, (event) => {
				if (controller.signal.aborted) return;
				if (event.type === "sheet-start") { const p = prog[event.sheetId]; if (p) p.status = "running"; push(); }
				else if (event.type === "start") { const p = prog[event.sheetId]; if (p) p.total = event.total; push(); }
				else if (event.type === "case") { const p = prog[event.sheetId]; if (p) { p.done += 1; p.counts[event.result.verdict] = (p.counts[event.result.verdict] || 0) + 1; } push(); }
				else if (event.type === "sheet-done") { const p = prog[event.sheetId]; if (p) { p.status = "done"; p.counts = event.view.counts; p.done = event.view.results.length; p.total = event.view.results.length; } push(); }
				else if (event.type === "sheet-error") { const p = prog[event.sheetId]; if (p) { p.status = "error"; p.error = event.error; } push(); }
				else if (event.type === "all-done") { setDone(true); onDone(); }
				else if (event.type === "error") throw new Error(event.error);
			}, controller.signal);
		} catch (error) {
			if (!controller.signal.aborted) setRunError((error as Error).message);
		} finally {
			if (runController.current === controller) { runController.current = null; setRunning(false); }
		}
	}

	const lang = useLang();
	const t = S[lang];
	if (!project) return <section><h2 className="sec">{t.workbench}</h2><div className="muted">{t.noProject}</div></section>;

	return (
		<section>
			<div className="dash-head">
				<h2 className="sec">{t.workbench}</h2>
				<span className="ctx">{project.name} · {sheet?.name ?? t.noSheetSelected}</span>
			</div>
			<div className="run-workbench">
				<RunRail done={done} live={Boolean(live)} running={running} />
				<div className="run-stage">
					<div className="run-config">
						<h3>{t.runReady}</h3>
						<p className="run-target">{t.target(project.baseUrl || (project.id === "sample" ? t.builtinSample : t.targetUnset))}<br />{t.sheet(sheet?.name ?? t.sheetUnselected)}</p>
						<label className="run-toggle"><input type="checkbox" checked={ai} onChange={(event) => setAi(event.target.checked)} /><span>{t.aiInterpret}<br /><small className="muted">{t.aiInterpretHint}</small></span></label>
						<label className="run-toggle"><input type="checkbox" checked={headed} onChange={(event) => setHeaded(event.target.checked)} /><span>{t.showBrowser}<br /><small className="muted">{t.showBrowserHint}</small></span></label>
						<div className="run-actions"><button className="button primary" type="button" disabled={running} onClick={startRun}><Icon name="play" />{running ? t.running : t.start}</button>{project.sheets.length > 1 && <button className="button secondary" type="button" disabled={running} onClick={startRunAll}>{t.runAll}</button>}<span className="muted" aria-live="polite">{statusMessage}</span></div>
					</div>
					{previewError && <div className="card err">{t.previewFail(previewError)} <button className="mini" type="button" onClick={loadPreview}>{t.retry}</button></div>}
					{!live && previewLoading && <div className="card late">{[0, 1, 2].map((index) => <div className="skel" style={{ height: 18, marginTop: index === 0 ? 0 : 12 }} key={index} />)}</div>}
					{!live && preview && <PreviewTable preview={preview} />}
					{runError && <div className="card err" role="alert">{t.error(runError)}</div>}
					{live && <RunResults view={live} total={done ? undefined : total} />}
					{runAll && (
						<div className="preview-surface">
							<div className="summary"><b>{t.runAllTitle}</b>{VERDICTS.map((v) => <span className="chip" key={v}>{vLabel(v, lang)} <b>{runAll.order.reduce((sum, id) => sum + (runAll.prog[id]?.counts[v] || 0), 0)}</b></span>)}</div>
							<div className="tscroll">
								<table>
									<thead><tr><th>{t.sheetCol}</th><th>{t.statusCol}</th>{VERDICTS.map((v) => <th className="num" key={v}>{vLabel(v, lang)}</th>)}</tr></thead>
									<tbody>
										{runAll.order.map((id) => {
											const p = runAll.prog[id];
											if (!p) return null;
											const st = p.status === "running" ? `${t.stRunning} ${p.done}/${p.total || "?"}` : p.status === "done" ? t.stDone : p.status === "error" ? t.stError : t.stPending;
											return (
												<tr key={id}>
													<td>{p.name}</td>
													<td className="detail">{st}{p.error ? ` — ${p.error}` : ""}</td>
													{VERDICTS.map((v) => <td className="num" key={v}>{p.counts[v] || 0}</td>)}
												</tr>
											);
										})}
									</tbody>
								</table>
							</div>
						</div>
					)}
				</div>
			</div>
		</section>
	);
}
