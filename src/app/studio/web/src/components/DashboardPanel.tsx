import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { CaseView, Project, RunView, Verdict } from "../types";
import { DashboardQueueRow, DashboardSkeleton, EmptyMotif, Spark } from "./DashboardParts";
import { Icon } from "./Icon";
import { V_LABEL } from "./Verdict";

type Tab = "dash" | "rules" | "run" | "review";
type Filter = Verdict | "all";

const ACTION_ORDER: Record<Verdict, number> = { fail: 0, error: 1, needs_review: 2, pass: 3 };

function fmtAgo(at: number): string {
	const s = Math.max(0, Math.round((Date.now() - at) / 1000));
	if (s < 60) return "방금 전";
	if (s < 3600) return `${Math.floor(s / 60)}분 전`;
	if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
	return `${Math.floor(s / 86400)}일 전`;
}

function fmtRun(v: RunView): string {
	const d = new Date(v.at);
	const t = `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	return `${t} · ${v.interpreter === "ai" ? "AI" : "규칙"} 해석`;
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
}: {
	selId: string;
	project?: Project;
	selSheetId?: string;
	reviewCount: number;
	goTo: (t: Tab) => void;
	refreshKey?: number;
}) {
	const [history, setHistory] = useState<RunView[] | null>(null);
	const [loadErr, setLoadErr] = useState("");
	const [runIdx, setRunIdx] = useState(0);
	const [filter, setFilter] = useState<Filter>("all");
	const tbodyRef = useRef<HTMLTableSectionElement>(null);
	const loadRequest = useRef(0);

	const load = useCallback(() => {
		const requestId = ++loadRequest.current;
		void refreshKey;
		setHistory(null);
		setLoadErr("");
		setRunIdx(0);
		setFilter("all");
		const sheets = project?.sheets ?? [];
		if (sheets.length === 0) {
			setHistory([]);
			return;
		}
		// Roll up: fan out one /api/history call per sheet (small N), then merge newest-first —
		// each RunView already carries its own sheetId, so the merged list stays self-describing.
		Promise.allSettled(sheets.map((sheet) => api.history(selId, sheet.id)))
			.then((results) => {
				if (requestId !== loadRequest.current) return;
				const fulfilled = results.filter((result): result is PromiseFulfilledResult<RunView[]> => result.status === "fulfilled");
				if (fulfilled.length === 0) {
					const firstFailure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
					throw firstFailure?.reason instanceof Error ? firstFailure.reason : new Error("실행 기록을 불러오지 못했습니다.");
				}
				setHistory(fulfilled.flatMap((result) => result.value).sort((a, b) => b.at - a.at));
			})
			.catch((error) => {
				if (requestId === loadRequest.current) setLoadErr((error as Error).message);
			});
		// refreshKey bumps when a run finishes elsewhere — the panel stays mounted, so re-fetch explicitly.
	}, [selId, project, refreshKey]);
	useEffect(load, [load]);

	// The dashboard's primary view is scoped to the selected sheet; fall back to the first sheet
	// with any runs when nothing is selected yet.
	const effectiveSheetId = useMemo(() => {
		if (!history || history.length === 0) return selSheetId ?? "";
		if (selSheetId && history.some((r) => r.sheetId === selSheetId)) return selSheetId;
		return history[0]?.sheetId ?? selSheetId ?? "";
	}, [history, selSheetId]);

	const sheetRuns = useMemo(
		() => (history ?? []).filter((r) => r.sheetId === effectiveSheetId),
		[history, effectiveSheetId],
	);

	const sheetName = useMemo(() => {
		const sheets = project?.sheets ?? [];
		return sheets.find((s) => s.id === effectiveSheetId)?.name ?? project?.name ?? selId;
	}, [project, effectiveSheetId, selId]);

	// Project roll-up: for each sheet, take its latest run and aggregate the pass rate across those
	// latest runs, plus how many sheets currently sit on a needs_review verdict.
	const rollup = useMemo(() => {
		const sheets = project?.sheets ?? [];
		if (!history || sheets.length === 0) return null;
		let passSum = 0;
		let totalSum = 0;
		let reviewSheets = 0;
		for (const sheet of sheets) {
			const latest = history.filter((r) => r.sheetId === sheet.id).sort((a, b) => b.at - a.at)[0];
			if (!latest) continue;
			passSum += latest.counts.pass || 0;
			totalSum += latest.results.length;
			if ((latest.counts.needs_review || 0) > 0) reviewSheets += 1;
		}
		return {
			sheetCount: sheets.length,
			reviewSheets,
			rate: totalSum === 0 ? null : passSum / totalSum,
		};
	}, [history, project]);

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
				<div>
					<p className="kicker">Quality operations</p>
					<h2 className="sec">실행 현황</h2>
				</div>
				<span className="ctx">
					{sheetName}
					{run ? ` · 마지막 실행 ${fmtAgo(run.at)}` : ""}
				</span>
				{history && sheetRuns.length > 0 && (
					<button className="mini" type="button" onClick={() => goTo("run")}>
						새 실행 →
					</button>
				)}
			</div>

			{loadErr && (
				<div className="card err">
					실행 기록을 불러오지 못했습니다: {loadErr}{" "}
					<button className="mini" type="button" onClick={load} style={{ marginLeft: 8 }}>
						다시 시도
					</button>
				</div>
			)}

			{!loadErr && !history && <DashboardSkeleton />}

			{history && sheetRuns.length === 0 && (
				<div className="card dash-empty">
					<div className="empty-signal"><EmptyMotif /><span>Ready for first run</span></div>
					<div>
						<p className="kicker">Start here</p>
						<h3>시트에서 증거까지,<br />한 번의 실행으로 연결하세요.</h3>
						<p>첫 실행이 끝나면 통과율, 조치가 필요한 실패, 사람이 확인할 판정만 이 화면에 모입니다.</p>
						<ol className="run-rail empty-run-rail">
							<li className="rail-step active"><span className="rail-node">1</span><div><b>케이스 확인</b><p>선택한 시트의 테스트 케이스를 미리 봅니다.</p></div></li>
							<li className="rail-step"><span className="rail-node">2</span><div><b>브라우저 실행</b><p>규칙 또는 AI 해석으로 실제 동작을 검증합니다.</p></div></li>
							<li className="rail-step"><span className="rail-node">3</span><div><b>증거 검토</b><p>실패와 보류 판정에만 집중합니다.</p></div></li>
						</ol>
						<button className="button primary" type="button" onClick={() => goTo("run")}>
							<Icon name="play" /> 첫 실행 준비
						</button>
					</div>
				</div>
			)}

			{run && (
				<>
					{rollup && (
						<div className="metrics">
							<div className="metric">
								<div className="lbl">프로젝트 전체</div>
								<div className="val">{rollup.rate === null ? "—" : `${Math.round(rollup.rate * 100)}%`}</div>
								<div className="sub">
									{rollup.sheetCount}개 시트 · 검토 대기 {rollup.reviewSheets}개
								</div>
							</div>
						</div>
					)}
					<div className="metrics">
						<div className="metric hero">
							<div className="lbl">통과율</div>
							<div className="val">{rate === null ? "—" : `${Math.round(rate * 100)}%`}</div>
							<div className="sub">
								{delta === null
									? `케이스 ${run.results.length}개 기준`
									: delta === 0
										? "이전 실행과 동일"
										: `이전 실행 대비 ${delta > 0 ? "+" : ""}${delta}%p`}
							</div>
							{rates.length >= 2 ? <Spark rates={rates} /> : <div className="spark-hint">실행이 쌓이면 추이가 표시됩니다</div>}
						</div>
						<div className="metric">
							<div className="lbl">조치 필요</div>
							<div className="val">{actionable}</div>
							<div className="sub">
								실패 {run.counts.fail || 0} · 오류 {run.counts.error || 0}
							</div>
						</div>
						<div className="metric">
							<div className="lbl">리뷰 대기</div>
							<div className="val">{reviewCount}</div>
							<div className="sub">
								{reviewCount > 0 ? (
									<button className="linkbtn" type="button" style={{ padding: 0 }} onClick={() => goTo("review")}>
										리뷰 대기 열기 →
									</button>
								) : (
									"보류된 판정 없음"
								)}
							</div>
						</div>
						<div className="metric">
							<div className="lbl">최근 실행</div>
							<div className="val">{run.results.length}</div>
							<div className="sub">
								케이스 · {run.interpreter === "ai" ? "AI" : "규칙"} 해석 · {fmtAgo(run.at)}
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
								{f === "all" ? `전체 ${run.results.length}` : `${V_LABEL[f]} ${run.counts[f] || 0}`}
							</button>
						))}
						{filter !== "all" && (
							<button className="linkbtn" type="button" onClick={() => setFilter("all")}>
								필터 해제
							</button>
						)}
						<span className="spacer" />
						{sheetRuns.length > 1 && (
							<select value={runIdx} onChange={(e) => setRunIdx(Number(e.target.value))} aria-label="실행 선택">
								{sheetRuns.map((v, i) => (
									<option key={v.at} value={i}>
										{fmtRun(v)}
									</option>
								))}
							</select>
						)}
					</div>

					<div className="card">
						{queue.length === 0 ? (
							<div className="muted">{filter === "all" ? "이 실행에는 케이스가 없습니다." : `${V_LABEL[filter as Verdict]} 케이스가 없습니다.`}</div>
						) : (
							<div className="tscroll">
								<table className="queue">
								<thead>
									<tr>
										<th>케이스</th>
										<th>판정</th>
										<th className="num">검증</th>
										<th className="num">신뢰도</th>
										<th>상세</th>
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
