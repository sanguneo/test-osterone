import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useLang } from "../i18n";
import type { Lang } from "../i18n";
import type { CaseView, Project, RunView, Verdict } from "../types";
import { DashboardQueueRow, DashboardSkeleton, Spark } from "./DashboardParts";
import { Icon } from "./Icon";
import { vLabel } from "./Verdict";

const S = {
	ko: {
		dashTitle: "실행 현황",
		lastRun: (rel: string) => ` · 마지막 실행 ${rel}`,
		newRun: "새 실행 →",
		clearRuns: "실행 기록 지우기",
		clearConfirmQ: "실행 기록·리뷰·트레이스 삭제? (기준 화면은 유지)",
		clearYes: "지우기",
		clearing: "지우는 중…",
		clearCancel: "취소",
		clearFailed: (msg: string) => `지우기 실패: ${msg}`,
		historyFail: (msg: string) => `실행 기록을 불러오지 못했습니다: ${msg}`,
		retry: "다시 시도",
		firstRunTitle: "첫 실행 전",
		firstRunBody: "실행하면 판정 결과와 통과율 추이가 여기에 정리됩니다.",
		openWorkbench: "실행 작업대 열기",
		passRate: "통과율",
		casesBasis: (n: number) => `케이스 ${n}개 기준`,
		sameAsPrev: "이전 실행과 동일",
		vsPrev: (delta: number) => `이전 실행 대비 ${delta > 0 ? "+" : ""}${delta}%p`,
		sparkHint: "실행이 쌓이면 추이가 표시됩니다",
		actionable: "조치 필요",
		failErrorLine: (fail: number, error: number) => `실패 ${fail} · 오류 ${error}`,
		reviewQueue: "리뷰 대기",
		openReviewQueue: "리뷰 대기 열기 →",
		noHeldVerdicts: "보류된 판정 없음",
		recentRun: "최근 실행",
		caseInterpretLine: (interp: string, rel: string) => `케이스 · ${interp} 해석 · ${rel}`,
		ai: "AI",
		rule: "규칙",
		all: (n: number) => `전체 ${n}`,
		clearFilter: "필터 해제",
		selectRunAria: "실행 선택",
		noCasesInRun: "이 실행에는 케이스가 없습니다.",
		noVerdictCases: (v: string) => `${v} 케이스가 없습니다.`,
		caseCol: "케이스",
		verdictCol: "판정",
		verifyCol: "검증",
		confidenceCol: "신뢰도",
		detailCol: "상세",
	},
	en: {
		dashTitle: "Run overview",
		lastRun: (rel: string) => ` · Last run ${rel}`,
		newRun: "New run →",
		clearRuns: "Clear runs",
		clearConfirmQ: "Delete runs · review · traces? (baselines kept)",
		clearYes: "Clear",
		clearing: "Clearing…",
		clearCancel: "Cancel",
		clearFailed: (msg: string) => `Clear failed: ${msg}`,
		historyFail: (msg: string) => `Failed to load run history: ${msg}`,
		retry: "Retry",
		firstRunTitle: "Before the first run",
		firstRunBody: "Once you run, verdicts and pass-rate trends will appear here.",
		openWorkbench: "Open run workbench",
		passRate: "Pass rate",
		casesBasis: (n: number) => `Based on ${n} cases`,
		sameAsPrev: "Same as previous run",
		vsPrev: (delta: number) => `${delta > 0 ? "+" : ""}${delta}%p vs previous run`,
		sparkHint: "Trend appears once runs accumulate",
		actionable: "Needs action",
		failErrorLine: (fail: number, error: number) => `Fail ${fail} · Error ${error}`,
		reviewQueue: "Review queue",
		openReviewQueue: "Open review queue →",
		noHeldVerdicts: "No held verdicts",
		recentRun: "Recent run",
		caseInterpretLine: (interp: string, rel: string) => `Cases · ${interp} interpreted · ${rel}`,
		ai: "AI",
		rule: "Rule",
		all: (n: number) => `All ${n}`,
		clearFilter: "Clear filter",
		selectRunAria: "Select run",
		noCasesInRun: "This run has no cases.",
		noVerdictCases: (v: string) => `No ${v} cases.`,
		caseCol: "Case",
		verdictCol: "Verdict",
		verifyCol: "Verify",
		confidenceCol: "Confidence",
		detailCol: "Detail",
	},
} as const;

type Tab = "dash" | "rules" | "run" | "review";
type Filter = Verdict | "all";

const ACTION_ORDER: Record<Verdict, number> = { fail: 0, error: 1, needs_review: 2, pass: 3 };

function fmtAgo(at: number, lang: Lang): string {
	const s = Math.max(0, Math.round((Date.now() - at) / 1000));
	if (lang === "en") {
		if (s < 60) return "just now";
		if (s < 3600) return `${Math.floor(s / 60)}m ago`;
		if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
		return `${Math.floor(s / 86400)}d ago`;
	}
	if (s < 60) return "방금 전";
	if (s < 3600) return `${Math.floor(s / 60)}분 전`;
	if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
	return `${Math.floor(s / 86400)}일 전`;
}

function passRate(v: RunView): number | null {
	const total = v.results.length;
	return total === 0 ? null : (v.counts.pass || 0) / total;
}

export function DashboardPanel({
	selId,
	project,
	selSheetId,
	reviewCount,
	goTo,
	refreshKey = 0,
	onRefresh,
}: {
	selId: string;
	project?: Project;
	selSheetId?: string;
	reviewCount: number;
	goTo: (t: Tab) => void;
	refreshKey?: number;
	onRefresh?: () => void;
}) {
	const lang = useLang();
	const t = S[lang];
	const [history, setHistory] = useState<RunView[] | null>(null);
	const [loadErr, setLoadErr] = useState("");
	const [runIdx, setRunIdx] = useState(0);
	const [filter, setFilter] = useState<Filter>("all");
	const [confirmClear, setConfirmClear] = useState(false);
	const [clearing, setClearing] = useState(false);
	const [clearErr, setClearErr] = useState("");
	const tbodyRef = useRef<HTMLTableSectionElement>(null);
	const loadRequest = useRef(0);

	const load = useCallback(() => {
		const requestId = ++loadRequest.current;
		void refreshKey;
		setHistory(null);
		setLoadErr("");
		setRunIdx(0);
		setFilter("all");
		setConfirmClear(false);
		setClearErr("");
		if (!selSheetId) {
			setHistory([]);
			return;
		}
		api.history(selId, selSheetId)
			.then((runs) => {
				if (requestId !== loadRequest.current) return;
				setHistory(runs.toSorted((a, b) => b.at - a.at));
			})
			.catch((error) => {
				if (requestId === loadRequest.current) setLoadErr((error as Error).message);
			});
		// refreshKey bumps when a run finishes elsewhere — the panel stays mounted, so re-fetch explicitly.
	}, [selId, selSheetId, refreshKey]);
	useEffect(load, [load]);

	async function clearRuns() {
		setConfirmClear(false);
		setClearing(true);
		setClearErr("");
		try {
			await api.clearSheet(selId, selSheetId);
			onRefresh?.();
			load();
		} catch (e) {
			setClearErr(t.clearFailed((e as Error).message));
		} finally {
			setClearing(false);
		}
	}

	const sheetRuns = history ?? [];

	const sheetName = useMemo(() => {
		const sheets = project?.sheets ?? [];
		return sheets.find((sheet) => sheet.id === selSheetId)?.name ?? project?.name ?? selId;
	}, [project, selId, selSheetId]);

	const run = sheetRuns[runIdx];
	const prev = sheetRuns[runIdx + 1];

	const rate = run ? passRate(run) : null;
	const prevRate = prev ? passRate(prev) : null;
	const delta = rate !== null && prevRate !== null ? Math.round((rate - prevRate) * 100) : null;
	const rates = useMemo(
		() =>
			sheetRuns
				.map(passRate)
				.filter((r): r is number => r !== null)
				.reverse(),
		[sheetRuns],
	);

	const queue = useMemo(() => {
		if (!run) return [];
		const rows = filter === "all" ? run.results : run.results.filter((r) => r.verdict === filter);
		return rows.toSorted((a, b) => ACTION_ORDER[a.verdict] - ACTION_ORDER[b.verdict]);
	}, [run, filter]);

	// Arrow keys move between queue rows; Enter opens the row's action (review for held verdicts).
	function onRowKey(e: React.KeyboardEvent<HTMLTableRowElement>, r: CaseView) {
		if (e.key === "Enter" && r.verdict === "needs_review") {
			goTo("review");
			return;
		}
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		e.preventDefault();
		const rows = Array.from(tbodyRef.current?.querySelectorAll("tr") ?? []);
		const i = rows.indexOf(e.currentTarget);
		const next = rows[e.key === "ArrowDown" ? i + 1 : i - 1];
		next?.focus();
	}

	const actionable = run ? (run.counts.fail || 0) + (run.counts.error || 0) : 0;

	return (
		<section>
			<div className="dash-head">
				<h2 className="sec">{t.dashTitle}</h2>
				<span className="ctx">
					{sheetName}
					{run ? t.lastRun(fmtAgo(run.at, lang)) : ""}
				</span>
				{history && sheetRuns.length > 0 && (
					<>
						<button className="mini" type="button" onClick={() => goTo("run")}>
							{t.newRun}
						</button>
						{!confirmClear ? (
							<button className="mini" type="button" disabled={clearing} onClick={() => setConfirmClear(true)}>
								{clearing ? t.clearing : t.clearRuns}
							</button>
						) : (
							<>
								<span className="muted" style={{ fontSize: 12 }}>{t.clearConfirmQ}</span>
								<button className="mini" type="button" style={{ color: "var(--error-500, #ff5a52)" }} onClick={clearRuns}>
									{t.clearYes}
								</button>
								<button className="mini" type="button" onClick={() => setConfirmClear(false)}>
									{t.clearCancel}
								</button>
							</>
						)}
					</>
				)}
			</div>
			{clearErr && <div className="card err">{clearErr}</div>}

			{loadErr && (
				<div className="card err">
					{t.historyFail(loadErr)}{" "}
					<button className="mini" type="button" onClick={load} style={{ marginLeft: 8 }}>
						{t.retry}
					</button>
				</div>
			)}

			{!loadErr && !history && <DashboardSkeleton />}

			{history && sheetRuns.length === 0 && (
				<div className="empty-state first-run-empty">
					<span className="empty-state-icon"><Icon name="play" size={24} /></span>
					<div>
						<h3>{t.firstRunTitle}</h3>
						<p>{t.firstRunBody}</p>
					</div>
					<button className="button primary" type="button" onClick={() => goTo("run")}><Icon name="play" />{t.openWorkbench}</button>
				</div>
			)}

			{run && (
				<>
					<div className="metrics">
						<div className="metric hero">
							<div className="lbl">{t.passRate}</div>
							<div className="val">{rate === null ? "—" : `${Math.round(rate * 100)}%`}</div>
							<div className="sub">
								{delta === null
									? t.casesBasis(run.results.length)
									: delta === 0
										? t.sameAsPrev
										: t.vsPrev(delta)}
							</div>
							{rates.length >= 2 ? <Spark rates={rates} /> : <div className="spark-hint">{t.sparkHint}</div>}
						</div>
						<div className="metric">
							<div className="lbl">{t.actionable}</div>
							<div className="val">{actionable}</div>
							<div className="sub">
								{t.failErrorLine(run.counts.fail || 0, run.counts.error || 0)}
							</div>
						</div>
						<div className="metric">
							<div className="lbl">{t.reviewQueue}</div>
							<div className="val">{reviewCount}</div>
							<div className="sub">
								{reviewCount > 0 ? (
									<button className="linkbtn" type="button" style={{ padding: 0 }} onClick={() => goTo("review")}>
										{t.openReviewQueue}
									</button>
								) : (
									t.noHeldVerdicts
								)}
							</div>
						</div>
						<div className="metric">
							<div className="lbl">{t.recentRun}</div>
							<div className="val">{run.results.length}</div>
							<div className="sub">
								{t.caseInterpretLine(run.interpreter === "ai" ? t.ai : t.rule, fmtAgo(run.at, lang))}
							</div>
						</div>
					</div>

					<div className="qbar">
						{(["all", "fail", "error", "needs_review", "pass"] as const).map((f) => (
							<button
								key={f}
								type="button"
								className={`f${filter === f ? " on" : ""}`}
								onClick={() => setFilter(f)}
							>
								{f === "all" ? t.all(run.results.length) : `${vLabel(f, lang)} ${run.counts[f] || 0}`}
							</button>
						))}
						{filter !== "all" && (
							<button className="linkbtn" type="button" onClick={() => setFilter("all")}>
								{t.clearFilter}
							</button>
						)}
						<span className="spacer" />
						{sheetRuns.length > 1 && <select value={runIdx} onChange={(event) => setRunIdx(Number(event.target.value))} aria-label={t.selectRunAria}>{sheetRuns.map((item, index) => <option key={item.at} value={index}>{new Date(item.at).toLocaleString("ko-KR")} · {item.interpreter === "ai" ? t.ai : t.rule}</option>)}</select>}
					</div>

					<div className="data-surface">
						{queue.length === 0 ? (
							<div className="muted">{filter === "all" ? t.noCasesInRun : t.noVerdictCases(vLabel(filter as Verdict, lang))}</div>
						) : (
							<div className="tscroll">
								<table className="queue">
								<thead>
									<tr>
										<th>{t.caseCol}</th>
										<th>{t.verdictCol}</th>
										<th className="num">{t.verifyCol}</th>
										<th className="num">{t.confidenceCol}</th>
										<th>{t.detailCol}</th>
									</tr>
								</thead>
								<tbody ref={tbodyRef}>
									{queue.map((r) => (
										<DashboardQueueRow key={r.caseId} result={r} onKey={(e) => onRowKey(e, r)} goReview={() => goTo("review")} />
									))}
								</tbody>
								</table>
								</div>
						)}
					</div>
				</>
			)}
		</section>
	);
}
