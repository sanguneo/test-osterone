import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { ReviewItem } from "../types";

export function ReviewPanel({ selId, onCount }: { selId: string; onCount: (n: number) => void }) {
	const [items, setItems] = useState<ReviewItem[]>([]);

	const load = useCallback(() => {
		api
			.reviewQueue(selId)
			.then((q) => {
				setItems(q);
				onCount(q.length);
			})
			.catch(() => {});
	}, [selId, onCount]);

	useEffect(load, [load]);

	async function approve(caseId: string) {
		try {
			const { queue } = await api.reviewApprove(caseId, selId);
			setItems(queue);
			onCount(queue.length);
		} catch (e) {
			alert((e as Error).message);
		}
	}

	return (
		<section>
			<h2 className="sec">리뷰 큐</h2>
			{items.length === 0 && (
				<div className="muted">
					needs_review 케이스가 없습니다. 실행 후 여기서 증거(스크린샷)를 확인하고 baseline을 승인하세요.
				</div>
			)}
			{items.map((it) => (
				<div className="rev-item" key={it.caseId}>
					{it.screenshot && <img src={it.screenshot} alt="screenshot" />}
					<div className="rev-body">
						<div>
							<span className={`badge v-${it.verdict}`}>{it.verdict}</span> <b>{it.title}</b>
						</div>
						<div className="why">
							사유: {it.reason}
							{it.url ? ` · ${it.url}` : ""}
						</div>
						<div className="txt">{it.text || "(빈 페이지)"}</div>
						<button className="approve" type="button" onClick={() => approve(it.caseId)}>
							baseline 승인
						</button>
					</div>
				</div>
			))}
		</section>
	);
}
