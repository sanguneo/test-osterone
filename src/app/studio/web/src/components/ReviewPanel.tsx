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
			setApproveErr(`전체 승인 실패: ${(e as Error).message} — 다시 시도하세요.`);
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
				<div>
					<p className="kicker">Human review</p>
					<h2 className="sec">리뷰 대기</h2>
				</div>
				<span className="ctx">엔진이 스스로 판정하지 못해, 사람이 화면을 보고 확정해야 하는 케이스입니다.</span>
				{items && items.length > 1 && (
					<div className="rev-actions">
						{!confirmAll ? (
							<button className="mini" type="button" disabled={busyAll} onClick={() => setConfirmAll(true)}>
								{busyAll ? "승인 중…" : `전체 승인 (${items.length})`}
							</button>
						) : (
							<>
								<span className="muted" style={{ fontSize: 12.5 }}>
									{items.length}건을 모두 확인했나요?
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
				)}
			</div>
			{loadErr && (
				<div className="card err">
					리뷰 대기 목록을 불러오지 못했습니다: {loadErr}{" "}
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
							<div className="skel" style={{ width: 170, height: 38, alignSelf: "flex-end" }} />
						</div>
					))}
				</div>
			)}
			{items && items.length === 0 && (
				<div className="muted">
					확인할 케이스가 없습니다. 엔진이 판정을 보류하면, 여기서 화면을 확인하고 기준 화면으로 승인합니다.
				</div>
			)}
			{approveErr && <div className="card err">{approveErr}</div>}
			{items?.map((it) => (
				<article className="rev-item" key={it.caseId}>
					<div className="rev-body">
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
							<span className="lbl">확인이 필요한 이유</span>
							{it.reason}
						</div>
						<div className="rev-txt-wrap">
							<span className="lbl">화면 텍스트</span>
							<div className="txt">{it.text || "(빈 페이지)"}</div>
						</div>
					</div>
					{it.screenshot ? (
						<figure className="rev-evidence">
							<img src={it.screenshot} alt={`${it.title} 화면`} />
							<figcaption>화면 · {it.url || "URL 없음"}</figcaption>
						</figure>
					) : (
						<div className="rev-evidence rev-evidence-empty">화면 캡처가 없습니다</div>
					)}
					<footer className="rev-foot">
						<span className="rev-foot-note">
							승인하면 이 화면을 <b>기준 화면</b>으로 저장합니다 — 다음 실행부터 같은 화면이면 자동으로 통과해요.
						</span>
						<button className="approve" type="button" disabled={busyId === it.caseId} onClick={() => approve(it.caseId)}>
							{busyId === it.caseId ? "저장 중…" : "기준 화면으로 승인"}
						</button>
					</footer>
				</article>
			))}
		</section>
	);
}
