import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useLang } from "../i18n";
import type { ReviewItem } from "../types";
import { Icon } from "./Icon";
import { VerdictMark } from "./Verdict";

const S = {
	ko: {
		sectionTitle: "리뷰 대기",
		approving: "승인 중…",
		approveAll: (n: number) => `전체 승인 (${n})`,
		confirmAllQuestion: (n: number) => `${n}건을 모두 확인했나요?`,
		approveAllBtn: "모두 승인",
		cancel: "취소",
		viewIntro: "엔진이 보류한 판정을 화면 증거와 함께 확인합니다.",
		loadFailed: (msg: string) => `리뷰 대기 목록을 불러오지 못했습니다: ${msg}`,
		retry: "다시 시도",
		emptyTitle: "보류 판정 없음",
		emptyBody: "엔진이 판정을 보류하면 화면 증거와 함께 여기에 표시됩니다.",
		openRunBench: "실행 작업대 열기",
		approveAllFailed: (msg: string) => `전체 승인 실패: ${msg} — 다시 시도하세요.`,
		approveFailed: (msg: string) => `승인 실패: ${msg} — 다시 시도하거나 서버 로그를 확인하세요.`,
		reasonLabel: "확인이 필요한 이유",
		screenTextLabel: "화면 텍스트",
		emptyPage: "(빈 페이지)",
		screenAlt: (title: string) => `${title} 화면`,
		screenCaption: (url: string) => `화면 · ${url}`,
		noUrl: "URL 없음",
		noScreenshot: "화면 캡처가 없습니다",
		confirmSaveNote: "이 증거를 기준 화면으로 저장하면 다음 실행부터 자동 판정에 사용합니다.",
		saveConfirm: "저장 확정",
		reviewFootNote: "화면과 판정 사유를 확인한 뒤 기준 화면으로 저장합니다.",
		saving: "저장 중…",
		reviewBaseline: "기준 화면 검토",
		traceTitle: "트레이스",
		traceHint: "— 행동 단위로 스크럽(죽은 시간 자동 스킵). 스크린샷보다 정밀합니다.",
		traceOpen: "▶ 트레이스 뷰어 열기",
		traceClose: "트레이스 뷰어 (아래 ↓)",
		traceNewTab: "새 탭에서 크게 ↗",
		traceDownload: "trace.zip 다운로드",
		markFail: "실패로 처리",
		processing: "처리 중…",
		rejectFailed: (msg: string) => `실패 처리 실패: ${msg} — 다시 시도하세요.`,
	},
	en: {
		sectionTitle: "Review queue",
		approving: "Approving…",
		approveAll: (n: number) => `Approve all (${n})`,
		confirmAllQuestion: (n: number) => `Have you checked all ${n} items?`,
		approveAllBtn: "Approve all",
		cancel: "Cancel",
		viewIntro: "Review verdicts the engine held, along with screen evidence.",
		loadFailed: (msg: string) => `Failed to load the review queue: ${msg}`,
		retry: "Retry",
		emptyTitle: "No pending verdicts",
		emptyBody: "When the engine holds a verdict, it appears here with screen evidence.",
		openRunBench: "Open run bench",
		approveAllFailed: (msg: string) => `Approve all failed: ${msg} — try again.`,
		approveFailed: (msg: string) => `Approve failed: ${msg} — try again or check the server logs.`,
		reasonLabel: "Reason for review",
		screenTextLabel: "Screen text",
		emptyPage: "(empty page)",
		screenAlt: (title: string) => `${title} screenshot`,
		screenCaption: (url: string) => `Screen · ${url}`,
		noUrl: "No URL",
		noScreenshot: "No screen capture available",
		confirmSaveNote: "Saving this evidence as baseline uses it for automatic verdicts from the next run onward.",
		saveConfirm: "Confirm save",
		reviewFootNote: "Review the screen and verdict reason, then save it as the baseline.",
		saving: "Saving…",
		reviewBaseline: "Review baseline",
		traceTitle: "Trace",
		traceHint: "— scrub action-by-action (dead time auto-skipped). More precise than a screenshot.",
		traceOpen: "▶ Open trace viewer",
		traceClose: "Trace viewer (below ↓)",
		traceNewTab: "Open larger in a new tab ↗",
		traceDownload: "Download trace.zip",
		markFail: "Mark as fail",
		processing: "Processing…",
		rejectFailed: (msg: string) => `Mark-as-fail failed: ${msg} — try again.`,
	},
} as const;

export function ReviewPanel({
	selId,
	selSheetId,
	sheetName,
	onCount,
	onRun,
	refreshKey = 0,
}: {
	selId: string;
	selSheetId: string;
	sheetName: string;
	onCount: (n: number) => void;
	onRun: () => void;
	refreshKey?: number;
}) {
	const t = S[useLang()];
	const [items, setItems] = useState<ReviewItem[] | null>(null);
	const [loadErr, setLoadErr] = useState("");
	const [approveErr, setApproveErr] = useState("");
	const [busyId, setBusyId] = useState("");
	const [confirmId, setConfirmId] = useState("");
	const [confirmAll, setConfirmAll] = useState(false);
	const [busyAll, setBusyAll] = useState(false);
	const [openTraceId, setOpenTraceId] = useState("");

	const traceZipUrl = (it: ReviewItem) =>
		`/api/trace?projectId=${encodeURIComponent(selId)}&sheetId=${encodeURIComponent(it.sheetId)}&caseId=${encodeURIComponent(it.caseId)}`;
	const traceViewerUrl = (it: ReviewItem) => `/trace-viewer/index.html?trace=${encodeURIComponent(traceZipUrl(it))}`;

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
			setApproveErr(t.approveAllFailed((e as Error).message));
		} finally {
			setBusyAll(false);
		}
	}

	async function approve(caseId: string) {
		setConfirmId("");
		setBusyId(caseId);
		setApproveErr("");
		try {
			const { queue } = await api.reviewApprove(caseId, selId, selSheetId);
			setItems(queue);
			onCount(queue.length);
		} catch (e) {
			setApproveErr(t.approveFailed((e as Error).message));
		} finally {
			setBusyId("");
		}
	}

	async function reject(caseId: string) {
		setConfirmId("");
		setBusyId(caseId);
		setApproveErr("");
		try {
			const { queue } = await api.reviewReject(caseId, selId, selSheetId);
			setItems(queue);
			onCount(queue.length);
		} catch (e) {
			setApproveErr(t.rejectFailed((e as Error).message));
		} finally {
			setBusyId("");
		}
	}

	return (
		<section>
			<div className="dash-head">
				<h2 className="sec">{t.sectionTitle}</h2>
				<span className="ctx">{sheetName}</span>
				{items && items.length > 1 && (
					<div className="rev-actions">
						{!confirmAll ? (
							<button className="mini" type="button" disabled={busyAll} onClick={() => setConfirmAll(true)}>
								{busyAll ? t.approving : t.approveAll(items.length)}
							</button>
						) : (
							<>
								<span className="muted" style={{ fontSize: 12.5 }}>
									{t.confirmAllQuestion(items.length)}
								</span>
								<button className="mini" type="button" style={{ color: "var(--review)" }} onClick={approveAll}>
									{t.approveAllBtn}
								</button>
								<button className="mini" type="button" onClick={() => setConfirmAll(false)}>
									{t.cancel}
								</button>
							</>
						)}
					</div>
				)}
			</div>
			{items && items.length > 0 && <p className="view-intro">{t.viewIntro}</p>}
			{loadErr && (
				<div className="card err">
					{t.loadFailed(loadErr)}{" "}
					<button className="mini" type="button" onClick={load} style={{ marginLeft: 8 }}>
						{t.retry}
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
				<div className="empty-state review-empty">
					<span className="empty-state-icon"><Icon name="review" size={24} /></span>
					<div>
						<h3>{t.emptyTitle}</h3>
						<p>{t.emptyBody}</p>
					</div>
					<button className="button secondary" type="button" onClick={onRun}><Icon name="play" />{t.openRunBench}</button>
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
							<span className="lbl">{t.reasonLabel}</span>
							{it.reason}
						</div>
						<div className="rev-txt-wrap">
							<span className="lbl">{t.screenTextLabel}</span>
							<div className="txt">{it.text || t.emptyPage}</div>
						</div>
					</div>
					{it.screenshot ? (
						<figure className="rev-evidence">
							<img src={it.screenshot} alt={t.screenAlt(it.title)} />
							<figcaption>{t.screenCaption(it.url || t.noUrl)}</figcaption>
						</figure>
					) : (
						<div className="rev-evidence rev-evidence-empty">{t.noScreenshot}</div>
					)}
					{it.trace && (
						<section className="rev-trace">
							<h3>
								{t.traceTitle} <span className="muted" style={{ fontWeight: 400 }}>{t.traceHint}</span>
							</h3>
							<div className="trace-actions" style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
								<button
									className="button secondary compact"
									type="button"
									disabled={openTraceId === it.caseId}
									onClick={() => setOpenTraceId(it.caseId)}
								>
									{openTraceId === it.caseId ? t.traceClose : t.traceOpen}
								</button>
								<a href={traceViewerUrl(it)} target="_blank" rel="noopener" style={{ fontSize: 12 }}>{t.traceNewTab}</a>
								<a href={traceZipUrl(it)} download style={{ fontSize: 12 }}>{t.traceDownload}</a>
							</div>
							{openTraceId === it.caseId && (
								<iframe title={t.traceTitle} src={traceViewerUrl(it)} className="trace-frame" style={{ width: "100%", height: 620, border: "1px solid var(--hairline, #333)", borderRadius: 8, marginTop: 10 }} />
							)}
						</section>
					)}
					<footer className="rev-foot">
						{confirmId === it.caseId ? (
							<>
								<span className="rev-foot-note confirm-note">{t.confirmSaveNote}</span>
								<button className="button secondary compact" type="button" onClick={() => setConfirmId("")}>{t.cancel}</button>
								<button className="approve" type="button" onClick={() => approve(it.caseId)}>{t.saveConfirm}</button>
							</>
						) : (
							<>
								<span className="rev-foot-note">{t.reviewFootNote}</span>
								<button className="button secondary compact" type="button" disabled={busyId === it.caseId} style={{ color: "var(--error-500, #ff5a52)" }} onClick={() => reject(it.caseId)}>
									{busyId === it.caseId ? t.processing : t.markFail}
								</button>
								<button className="approve" type="button" disabled={busyId === it.caseId} onClick={() => setConfirmId(it.caseId)}>
									{busyId === it.caseId ? t.saving : t.reviewBaseline}
								</button>
							</>
						)}
					</footer>
				</article>
			))}
		</section>
	);
}
