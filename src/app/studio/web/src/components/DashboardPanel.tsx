import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { CaseView, Project, RunView, Verdict } from "../types";
import { SelfHealNote, stripAnsi, V_LABEL, VerdictMark } from "./Verdict";

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

/** Pass-rate sparkline over run history (oldest → newest), inline SVG. */
function Spark({ rates }: { rates: number[] }) {
	if (rates.length < 2) return null;
	const w = 120;
	const h = 32;
	const min = Math.min(...rates);
	const max = Math.max(...rates);
	const span = max - min;
	const pts = rates.map((r, i) => {
		const x = (i / (rates.length - 1)) * w;
		const y = span === 0 ? h / 2 : 3 + (1 - (r - min) / span) * (h - 6);
		return `${x.toFixed(1)},${y.toFixed(1)}`;
	});
	return (
		<svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
			<defs>
				<linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" stopColor="var(--lime)" stopOpacity="0.15" />
					<stop offset="1" stopColor="var(--lime)" stopOpacity="0" />
				</linearGradient>
			</defs>
			<polygon fill="url(#sparkfill)" points={`0,${h} ${pts.join(" ")} ${w},${h}`} />
			<polyline fill="none" stroke="var(--lime)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" points={pts.join(" ")} />
			{/* zero-length round-capped stroke = endpoint dot that survives non-uniform scaling */}
			<path
				d={`M ${(pts[pts.length - 1] ?? "").replace(",", " ")} l 0.01 0`}
				stroke="var(--lime)"
				strokeWidth="5"
				strokeLinecap="round"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}

/** Empty-state motif: a case grid with one lime check — the domain in one glyph. */
function EmptyMotif() {
	const cells = [0, 1, 2, 3, 4, 5, 6, 7, 8];
	return (
		<svg width="96" height="96" viewBox="0 0 96 96" aria-hidden="true">
			{cells.map((i) => (
				<rect
					key={i}
					x={6 + (i % 3) * 30}
					y={6 + Math.floor(i / 3) * 30}
					width="24"
					height="24"
					rx="6"
					fill={i === 4 ? "rgba(158,230,0,.12)" : "none"}
					stroke={i === 4 ? "var(--lime)" : "var(--line)"}
					strokeWidth="1.5"
				/>
			))}
			<path d="M42 48 l4 4 l8 -8" fill="none" stroke="var(--lime)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function Skeleton() {
	return (
		<div className="late">
			<div className="metrics">
				{[0, 1, 2, 3].map((i) => (
					<div className="metric" key={i}>
						<div className="skel" style={{ width: 90, height: 12 }} />
						<div className="skel" style={{ width: 70, height: i === 0 ? 34 : 26, marginTop: 8 }} />
						<div className="skel" style={{ width: 110, height: 11, marginTop: 8 }} />
						{i === 0 && <div className="skel" style={{ height: 32, marginTop: 10 }} />}
					</div>
				))}
			</div>
			<div className="card">
				{[0, 1, 2, 3, 4].map((i) => (
					<div className="skel" style={{ height: 20, marginTop: i === 0 ? 0 : 14 }} key={i} />
				))}
			</div>
		</div>
	);
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

	const load = useCallback(() => {
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
		Promise.all(sheets.map((s) => api.history(selId, s.id).catch(() => [] as RunView[])))
			.then((lists) => setHistory(lists.flat().sort((a, b) => b.at - a.at)))
			.catch((e) => setLoadErr((e as Error).message));
		// refreshKey bumps when a run finishes elsewhere — the panel stays mounted, so re-fetch explicitly.
	}, [selId, project, refreshKey]);
	useEffect(load, [load]);

	const run = history?.[runIdx];
	const prev = history?.[runIdx + 1];

	const rate = run ? passRate(run) : null;
	const prevRate = prev ? passRate(prev) : null;
	const delta = rate !== null && prevRate !== null ? Math.round((rate - prevRate) * 100) : null;
	const rates = useMemo(
		() =>
			(history ?? [])
				.map(passRate)
				.filter((r): r is number => r !== null)
				.reverse(),
		[history],
	);

	const queue = useMemo(() => {
		if (!run) return [];
		const rows = filter === "all" ? run.results : run.results.filter((r) => r.verdict === filter);
		return [...rows].sort((a, b) => ACTION_ORDER[a.verdict] - ACTION_ORDER[b.verdict]);
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
				<h2 className="sec" style={{ margin: 0 }}>
					대시보드
				</h2>
				<span className="ctx">
					{project?.name ?? selId}
					{run ? ` · 마지막 실행 ${fmtAgo(run.at)}` : ""}
				</span>
				{history && history.length > 0 && (
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

			{!loadErr && !history && <Skeleton />}

			{history && history.length === 0 && (
				<div className="card dash-empty">
					<EmptyMotif />
					<p>아직 실행 기록이 없습니다. 첫 실행이 끝나면 통과율 추이와 조치가 필요한 케이스가 여기에 모입니다.</p>
					<button className="run" type="button" style={{ marginTop: 0 }} onClick={() => goTo("run")}>
						첫 실행 시작
					</button>
				</div>
			)}

			{run && (
				<>
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
										리뷰 큐 열기 →
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
						{history.length > 1 && (
							<select value={runIdx} onChange={(e) => setRunIdx(Number(e.target.value))} aria-label="실행 선택">
								{history.map((v, i) => (
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
										<th className="num">Assert</th>
										<th className="num">신뢰도</th>
										<th>상세</th>
									</tr>
								</thead>
								<tbody ref={tbodyRef}>
									{queue.map((r) => (
										<QueueRow key={r.caseId} r={r} onKey={(e) => onRowKey(e, r)} goReview={() => goTo("review")} />
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

function QueueRow({
	r,
	onKey,
	goReview,
}: {
	r: CaseView;
	onKey: (e: React.KeyboardEvent<HTMLTableRowElement>) => void;
	goReview: () => void;
}) {
	const firstFail = r.assertions.find((a) => !a.passed);
	return (
		<tr tabIndex={0} onKeyDown={onKey}>
			<td className="ttl">{r.title || r.caseId}</td>
			<td>
				<VerdictMark verdict={r.verdict} />
			</td>
			<td className="num">
				{r.passed}/{r.total}
			</td>
			<td className="num">{r.confidence.toFixed(2)}</td>
			<td>
				{firstFail && <div className="detail">{stripAnsi(firstFail.detail)}</div>}
				<SelfHealNote heal={r.heal} />
				{r.verdict === "needs_review" && (
					<button className="linkbtn" type="button" onClick={goReview}>
						리뷰 →
					</button>
				)}
			</td>
		</tr>
	);
}
