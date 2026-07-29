import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { type Lang, useLang } from "../i18n";
import type { ReviewItem } from "../types";
import { Icon } from "./Icon";
import { stripAnsi, VerdictMark } from "./Verdict";

const S = {
	ko: {
		sectionTitle: "리뷰 대기",
		cancel: "취소",
		viewIntro: "엔진이 보류한 판정을 화면 증거와 함께 확인합니다.",
		loadFailed: (msg: string) => `리뷰 대기 목록을 불러오지 못했습니다: ${msg}`,
		retry: "다시 시도",
		emptyTitle: "보류 판정 없음",
		emptyBody: "엔진이 판정을 보류하면 화면 증거와 함께 여기에 표시됩니다.",
		openRunBench: "실행 작업대 열기",
		approveFailed: (msg: string) => `승인 실패: ${msg} — 다시 시도하거나 서버 로그를 확인하세요.`,
		reasonLabel: "확인이 필요한 이유",
		reasonSelfHeal: (op: string, target: string) =>
			target
				? `화면에서 '${target}' 요소를 찾지 못해 '${op}' 동작을 건너뛰었습니다. 라벨·텍스트가 다르거나 이전 단계가 실패했을 수 있으니, 그 요소가 화면에 실제로 있는지 화면·트레이스로 확인하세요.`
				: `요소를 찾지 못해 '${op}' 동작을 건너뛰었습니다. 화면·트레이스로 원인을 확인하세요.`,
		reasonPreconditionUnmet: (target: string) =>
			`이 케이스가 전제하는 시작 상태에 도달하지 못했습니다${target ? ` — 준비 동작 '${target}' 실패` : ""}. 케이스가 검증하려던 것은 실행되지 않았으므로 앱 결함으로 볼 수 없습니다. 시트의 사전조건이 실제 화면과 맞는지, 그 화면에 도달할 수 있는지 확인하세요.`,
		reasonAiRepair: (target: string) =>
			target
				? `'${target}' 동작이 실패해 AI가 실행 중 화면을 다시 읽고 대상을 교정한 뒤 진행했습니다. 교정된 동작이 테스트 의도와 같은지 화면·트레이스로 확인하고, 맞다면 기준으로 승인하세요.`
				: `동작이 실패해 AI가 실행 중 화면을 다시 읽고 교정한 뒤 진행했습니다. 교정이 의도와 같은지 화면·트레이스로 확인하세요.`,
		reasonStepNotInterpreted:
			"규칙이 해석하지 못한 스텝이 있어 그 동작은 실행되지 않았습니다. AI 스텝 해석을 켜거나, 스텝 문구를 팀 규칙(동작 키워드)에 맞게 다듬으세요.",
		reasonVisionDisagrees: (note: string) =>
			`엔진의 텍스트 검사는 실패했지만 AI가 스크린샷을 읽고 "충족"으로 판단했습니다. AI 판단은 판정이 아니라 참고이므로 자동 통과시키지 않고 보류했습니다 — 화면을 보고 결정하세요.${note ? ` (${note})` : ""}`,
		reasonNotDiscriminating: (note: string) =>
			`이 케이스의 검증은 동작 전 화면에서도 이미 통과합니다 — 동작이 실제로 무엇을 바꿨는지 구분하지 못합니다(예: 결과가 아니라 클릭 대상의 텍스트를 검사). 앱이 정상일 수도 있으니 화면을 보고 판단하고, 필요하면 예상결과 문구를 구체화하세요.${note ? ` (${note})` : ""}`,
		reasonPartlyChecked: (note: string) =>
			`예상결과에 적힌 항목 중 일부만 검증했습니다 — 통과한 검증만 보면 초록이지만, 검증하지 않은 항목이 실제로 깨져 있을 수 있어 보류했습니다. 화면을 확인해 판단하고, 필요하면 항목별로 검증 가능한 문구로 다듬으세요.${note ? ` (${note})` : ""}`,
		reasonNoAssertions: "이 케이스에 기대 결과(검증 항목)가 없어 통과/실패를 자동으로 판정할 수 없습니다. 화면을 보고 직접 판단하세요.",
		reasonBaselinePending: "비교 기준(baseline) 화면이 아직 승인되지 않았습니다. 현재 화면이 올바르면 기준으로 승인하세요.",
		reasonErrorInfo: (info: string) => `실행 중 오류가 발생해 판정을 보류했습니다: ${info} — 화면과 트레이스로 원인을 확인하세요.`,
		reasonErrorGeneric: "실행 중 오류가 발생해 판정을 보류했습니다. 화면과 트레이스로 원인을 확인하세요.",
		screenTextLabel: "화면 텍스트",
		stepsLabel: "테스트 내용",
		expectedLabel: "기대 결과",
		noExpected: "(기대 결과 없음)",
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
		traceNewTab: "새 탭에서 크게 ↗",
		traceDownload: "trace.zip 다운로드",
		markFail: "실패로 처리",
		processing: "처리 중…",
		rejectFailed: (msg: string) => `실패 처리 실패: ${msg} — 다시 시도하세요.`,
		notBaselineable: "작성된 대로 실행되지 않아 기준 화면으로 승인할 수 없습니다 — 규칙을 고치거나 모델을 연결해 다시 실행하세요.",
	},
	en: {
		sectionTitle: "Review queue",
		cancel: "Cancel",
		viewIntro: "Review verdicts the engine held, along with screen evidence.",
		loadFailed: (msg: string) => `Failed to load the review queue: ${msg}`,
		retry: "Retry",
		emptyTitle: "No pending verdicts",
		emptyBody: "When the engine holds a verdict, it appears here with screen evidence.",
		openRunBench: "Open run bench",
		approveFailed: (msg: string) => `Approve failed: ${msg} — try again or check the server logs.`,
		reasonLabel: "Reason for review",
		reasonSelfHeal: (op: string, target: string) =>
			target
				? `The '${target}' element couldn't be found, so the '${op}' action was skipped. Its label/text may differ or a previous step may have failed — check the screen and trace to see whether that element is actually present.`
				: `An element couldn't be found, so the '${op}' action was skipped. Check the screen and trace for the cause.`,
		reasonPreconditionUnmet: (target: string) =>
			`The starting state this case assumes was never reached${target ? ` — setup step '${target}' failed` : ""}. What the case set out to verify never ran, so this is not a defect in the app. Check whether the sheet's precondition matches the real screen, and whether that screen is reachable at all.`,
		reasonAiRepair: (target: string) =>
			target
				? `The '${target}' action failed, so the AI re-read the live screen mid-run, corrected the target and continued. Check the screen and trace that the correction matches the test's intent, then approve it as the baseline.`
				: `An action failed, so the AI re-read the live screen mid-run and corrected it before continuing. Check the screen and trace that the correction matches the intent.`,
		reasonStepNotInterpreted:
			"A step the rule engine couldn't interpret was not executed. Turn on AI step interpretation, or reword the step to match your team's action vocabulary.",
		reasonVisionDisagrees: (note: string) =>
			`The engine's text check failed, but the AI read the screenshot as satisfied. An AI reading is a hint, not a verdict, so this was held instead of auto-passed — look at the screen and decide.${note ? ` (${note})` : ""}`,
		reasonNotDiscriminating: (note: string) =>
			`This case's checks already passed on the screen *before* the action ran, so they can't tell whether the action changed anything (e.g. asserting the text of the element being clicked instead of the outcome). The app may well be fine — look at the screen, and consider making the expected result more specific.${note ? ` (${note})` : ""}`,
		reasonPartlyChecked: (note: string) =>
			`Only some of the outcomes listed in the expected result were checked — the assertions that ran are green, but an unchecked item could well be broken, so this was held. Review the screen, and consider rewording the expected result item by item so each one is checkable.${note ? ` (${note})` : ""}`,
		reasonNoAssertions: "This case has no expected result (assertions), so pass/fail can't be judged automatically. Review the screen and decide.",
		reasonBaselinePending: "The comparison baseline hasn't been approved yet. If the current screen is correct, approve it as the baseline.",
		reasonErrorInfo: (info: string) => `The run errored, so the verdict was held: ${info} — use the screen and trace to find the cause.`,
		reasonErrorGeneric: "The run errored, so the verdict was held. Use the screen and trace to find the cause.",
		screenTextLabel: "Screen text",
		stepsLabel: "Test steps",
		expectedLabel: "Expected result",
		noExpected: "(no expected result)",
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
		traceNewTab: "Open larger in a new tab ↗",
		traceDownload: "Download trace.zip",
		markFail: "Mark as fail",
		processing: "Processing…",
		rejectFailed: (msg: string) => `Mark-as-fail failed: ${msg} — try again.`,
		notBaselineable:
			"This case did not run as written, so it can't be approved as a baseline — fix the rule or connect a model and re-run.",
	},
} as const;

type ReviewStrings = (typeof S)[Lang];

const OP_LABEL: Record<Lang, Record<string, string>> = {
	ko: { fill: "입력", click: "클릭", press: "키 입력", select: "선택", check: "체크", uncheck: "체크 해제", hover: "마우스 오버", goto: "페이지 이동", navigate: "페이지 이동" },
	en: {},
};

/** Turn a terse engine reason code into a friendly, human-readable "why review" explanation. */
function explainReason(item: ReviewItem, t: ReviewStrings, lang: Lang): string {
	const reason = item.reason;
	if (reason.startsWith("self-heal:")) {
		const raw = reason.slice("self-heal:".length).trim();
		return t.reasonSelfHeal(OP_LABEL[lang][raw] ?? raw, item.healTarget ?? "");
	}
	if (reason === "precondition unmet") return t.reasonPreconditionUnmet(item.healTarget ?? "");
	if (reason === "ai repair") return t.reasonAiRepair(item.healTarget ?? "");
	if (reason === "step not interpreted") return t.reasonStepNotInterpreted;
	if (reason === "vision disagrees") return t.reasonVisionDisagrees(item.holdNote ?? "");
	if (reason === "assertion not discriminating") return t.reasonNotDiscriminating(item.holdNote ?? "");
	if (reason === "requirements partly checked") return t.reasonPartlyChecked(item.holdNote ?? "");
	if (reason === "no assertions authored") return t.reasonNoAssertions;
	if (reason === "baseline pending approval") return t.reasonBaselinePending;
	if (reason === "error" || reason.trim() === "") return t.reasonErrorGeneric;
	return t.reasonErrorInfo(stripAnsi(reason));
}

/** Steps often already carry their own "1." / "2)" prefix; strip it so the <ol> auto-numbering doesn't double up. */
const stripStepOrdinal = (s: string) => s.replace(/^\s*\d+[.)]\s+/, "");

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
	const lang = useLang();
	const t = S[lang];
	const [items, setItems] = useState<ReviewItem[] | null>(null);
	const [loadErr, setLoadErr] = useState("");
	const [approveErr, setApproveErr] = useState("");
	const [busyId, setBusyId] = useState("");
	const [confirmId, setConfirmId] = useState("");
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
				{/* No bulk-approve control: each item here is held because the engine could not confirm
				    that specific screen, so blessing them together is exactly the mistake. */}
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
							<div className="rev-badge-row">
								<VerdictMark verdict={it.verdict} />
								{it.category && <span className="cat-tag">{it.category}</span>}
								<span className="rev-meta">
									{it.caseId}
									{it.env ? ` · ${it.env}` : ""}
								</span>
							</div>
							<b className="rev-title">{it.title}</b>
						</header>
						{((it.steps?.length ?? 0) > 0 || it.expected) && (
							<div className="rev-tc">
								{(it.steps?.length ?? 0) > 0 && (
									<>
										<span className="lbl">{t.stepsLabel}</span>
										<ol className="rev-steps">
											{it.steps?.map((s, i) => (
												<li key={`${it.caseId}-s${i}`}>{stripStepOrdinal(s)}</li>
											))}
										</ol>
									</>
								)}
								<span className="lbl">{t.expectedLabel}</span>
								<p className="rev-expected">{it.expected || t.noExpected}</p>
							</div>
						)}
						<div className="rev-reason">
							<span className="lbl">{t.reasonLabel}</span>
							<p className="rev-reason-text">{explainReason(it, t, lang)}</p>
							<code className="rev-reason-code">{it.reason}</code>
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
							<button
								type="button"
								className="trace-toggle"
								aria-expanded={openTraceId === it.caseId}
								onClick={() => setOpenTraceId(openTraceId === it.caseId ? "" : it.caseId)}
							>
								<span className="trace-chevron"><Icon name="arrow" size={13} /></span>
								<span className="trace-toggle-title">{t.traceTitle}</span>
								<span className="muted trace-toggle-hint">{t.traceHint}</span>
							</button>
							{openTraceId === it.caseId && (
								<div className="trace-frame-wrap">
									<div className="trace-float">
										<a className="icon-button" href={traceViewerUrl(it)} target="_blank" rel="noopener" aria-label={t.traceNewTab} title={t.traceNewTab}><Icon name="external" size={18} /></a>
										<a className="icon-button" href={traceZipUrl(it)} download aria-label={t.traceDownload} title={t.traceDownload}><Icon name="download" size={18} /></a>
									</div>
									<iframe title={t.traceTitle} src={traceViewerUrl(it)} className="trace-frame" />
								</div>
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
						) : it.baselineEligible === false ? (
							<>
								{/* The case never ran as written, so there is no screen worth signing off — offer
								    only the honest verdict. */}
								<span className="rev-foot-note">{t.notBaselineable}</span>
								<button className="button secondary compact" type="button" disabled={busyId === it.caseId} style={{ color: "var(--error-500, #ff5a52)" }} onClick={() => reject(it.caseId)}>
									{busyId === it.caseId ? t.processing : t.markFail}
								</button>
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
