import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { ReviewItem } from "../types";
import { VerdictMark } from "./Verdict";

export function ReviewPanel({
	selId,
	selSheetId,
	onCount,
	refreshKey = 0,
}: {
	selId: string;
	selSheetId: string;
	onCount: (n: number) => void;
	refreshKey?: number;
}) {
	const [items, setItems] = useState<ReviewItem[] | null>(null);
	const [loadErr, setLoadErr] = useState("");
	const [approveErr, setApproveErr] = useState("");
	const [busyId, setBusyId] = useState("");
	const [confirmAll, setConfirmAll] = useState(false);
	const [busyAll, setBusyAll] = useState(false);

	const load = useCallback(() => {
		void refreshKey;
		setItems(null);
		setLoadErr("");
		api
			.reviewQueue(selId, selSheetId)
			.then((q) => {
				setItems(q);
				onCount(q.length);
			})
			.catch((e) => setLoadErr((e as Error).message));
		// refreshKey bumps when a run finishes — the panel stays mounted, so re-fetch explicitly.
	}, [selId, selSheetId, onCount, refreshKey]);

	useEffect(load, [load]);

	async function approveAll() {
		setConfirmAll(false);
		setBusyAll(true);
		setApproveErr("");
		try {
			const { queue } = await api.reviewApproveAll(selId, selSheetId);
			setItems(queue);
			onCount(queue.length);
		} catch (e) {
			setApproveErr(`일괄 승인 실패: ${(e as Error).message} — 다시 시도하세요.`);
		} finally {
			setBusyAll(false);
		}
	}

	async function approve(caseId: string) {
		setBusyId(caseId);
		setApproveErr("");
		try {
			const { queue } = await api.reviewApprove(caseId, selId, selSheetId);
			setItems(queue);
			onCount(queue.length);
		} catch (e) {
			setApproveErr(`승인 실패: ${(e as Error).message} — 다시 시도하거나 서버 로그를 확인하세요.`);
		} finally {
			setBusyId("");
		}
	}

	return (
		<section>
			<div className="dash-head">
				<h2 className="sec" style={{ margin: 0 }}>
					리뷰 큐
				</h2>
				<span className="ctx" />
				{items && items.length > 1 && !confirmAll && (
					<button className="mini" type="button" disabled={busyAll} onClick={() => setConfirmAll(true)}>
						{busyAll ? "일괄 승인 중…" : `전체 승인 (${items.length})`}
					</button>
				)}
				{confirmAll && (
					<>
						<span className="muted" style={{ fontSize: 12.5 }}>
							{items?.length}건의 증거를 모두 확인했습니까?
						</span>
						<button className="mini" type="button" style={{ color: "var(--review)" }} onClick={approveAll}>
							모두 승인
						</button>
						<button className="mini" type="button" onClick={() => setConfirmAll(false)}>
							취소
						</button>
					</>
				)}
			</div>
			{loadErr && (
				<div className="card err">
					리뷰 큐를 불러오지 못했습니다: {loadErr}{" "}
					<button className="mini" type="button" onClick={load} style={{ marginLeft: 8 }}>
						다시 시도
					</button>
				</div>
			)}
			{!loadErr && items === null && (
				<div className="late">
					{[0, 1].map((i) => (
						<div className="rev-item" key={i}>
							<div className="skel" style={{ width: 260, height: 18 }} />
							<div className="skel" style={{ height: 46 }} />
							<div className="skel" style={{ height: 200, maxWidth: 520 }} />
							<div className="skel" style={{ width: 140, height: 38, alignSelf: "flex-end" }} />
						</div>
					))}
				</div>
			)}
			{items && items.length === 0 && (
				<div className="muted">
					리뷰할 케이스가 없습니다. 판정 보류 케이스가 생기면 여기서 증거(스크린샷)를 확인하고 baseline을 승인합니다.
				</div>
			)}
			{approveErr && <div className="card err">{approveErr}</div>}
			{items?.map((it) => (
				<article className="rev-item" key={it.caseId}>
					<header className="rev-top">
						<span className="rev-title">
							<VerdictMark verdict={it.verdict} /> <b>{it.title}</b>
						</span>
						<span className="rev-meta">
							{it.caseId}
							{it.env ? ` · ${it.env}` : ""}
						</span>
					</header>
					<div className="rev-reason">
						<span className="lbl">보류 사유</span>
						{it.reason}
					</div>
					{it.screenshot && (
						<figure className="rev-evidence">
							<img src={it.screenshot} alt={`${it.title} 스크린샷`} />
							<figcaption>증거 · {it.url || "URL 없음"}</figcaption>
						</figure>
					)}
					<div className="rev-txt-wrap">
						<span className="lbl">페이지 텍스트</span>
						<div className="txt">{it.text || "(빈 페이지)"}</div>
					</div>
					<footer className="rev-foot">
						<span className="rev-foot-note">승인하면 이 화면이 baseline으로 확정됩니다</span>
						<button className="approve" type="button" disabled={busyId === it.caseId} onClick={() => approve(it.caseId)}>
							{busyId === it.caseId ? "승인 중…" : "baseline 승인"}
						</button>
					</footer>
				</article>
			))}
		</section>
	);
}
