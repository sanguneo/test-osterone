import { useEffect, useState } from "react";
import { api } from "../api";
import { useLang } from "../i18n";
import type { Project, Status } from "../types";
import { Icon } from "./Icon";

const S = {
	ko: {
		sectionTitle: "규칙·해석",
		noSheetSelected: "시트 선택 안됨",
		ruleVersion: (n: number) => `규칙 v${n}`,
		needProjectWithSource: "테스트 원본이 있는 프로젝트를 먼저 선택하세요.",
		analyzing: "시트 헤더를 AI가 해석하는 중…",
		headers: (h: string) => `헤더: ${h}`,
		analyzeFailed: (msg: string) => `시트 해석 실패: ${msg} — 원본과 모델 연결을 확인한 뒤 다시 시도하세요.`,
		refining: "AI가 규칙을 다듬는 중…",
		refineUpdated: (v: number) => `규칙 v${v} 갱신 · `,
		refineNoChange: "변경 없음 · ",
		refineFailed: (msg: string) => `규칙 다듬기 실패: ${msg} — 다시 보내거나 모델 연결 상태를 확인하세요.`,
		resetConfirm: "다듬은 규칙을 모두 버리고 기본 동작 사전으로 되돌립니다. 계속할까요?",
		resetFailed: (msg: string) => `초기화 실패: ${msg}`,
		interpretStatus: "시트 해석 상태",
		interpretLabel: "시트 해석",
		columnMapping: "열 매핑",
		reanalyze: "다시 해석",
		needModelConn: "모델 연결이 필요합니다",
		mappingNote: "AI가 제안한 열 매핑은 이 시트에만 저장됩니다.",
		noMapping: "저장된 매핑 없음",
		noMappingNote: "현재는 헤더 자동 감지를 사용합니다.",
		currentRule: "현재 규칙",
		defaultDictInUse: "기본 동작 사전 사용 중",
		conversationalEdit: "대화형 편집",
		refineRules: "규칙 다듬기",
		reset: "초기화",
		conversationNote: "자연어로 해석 규칙을 추가하거나 이전 지시를 되돌립니다. 변경 내용은 버전으로 남습니다.",
		modelNotConnected: "모델 미연결 — 시트 해석과 규칙 다듬기에는 모델이 필요합니다.",
		connectModel: "모델 연결",
		noRefinedYet: "아직 다듬은 규칙이 없습니다",
		exampleRefine: "예: “누르기도 click으로 해석해”",
		ruleInstruction: "규칙 지시",
		instructionPlaceholder: "자연어로 규칙을 지시하세요",
		applying: "반영 중",
		applyRule: "규칙 반영",
		appContextTitle: "AI 도메인 컨텍스트",
		appContextNote: "앱 설명·용어를 적어두면 AI가 이 시트의 스텝을 더 잘 해석합니다(AI 플랜 생성에만 사용).",
		appContextPlaceholder: "예: 은행 대시보드. '확인'=제출 버튼. 로그인은 /auth. 목록은 표로 렌더.",
		saveContext: "컨텍스트 저장",
		savingContext: "저장 중",
		contextSaved: "저장됨",
		contextSaveFailed: (msg: string) => `저장 실패: ${msg}`,
		reconButton: "라이브 앱 분석",
		reconDeepLabel: "하위 페이지까지",
		reconRunning: "라이브 앱을 정찰하는 중…",
		reconNote: "시트 주소(baseUrl)에 접속해 구조(내비·폼·표)를 스캔하고 도메인 컨텍스트 초안을 만듭니다. 계정이 연결돼 있으면 로그인도 시도합니다. 결과는 위 컨텍스트 칸에 채워지며 저장 전에 검토하세요.",
		reconDone: (n: number, logged: boolean) => `${n}개 페이지 스캔${logged ? " · 로그인됨" : ""} — 검토 후 저장`,
		reconFailed: (msg: string) => `앱 분석 실패: ${msg} — 주소·계정·모델 연결을 확인한 뒤 다시 시도하세요.`,
		codeContextTitle: "AI 코드 컨텍스트",
		codeContextNote: "프로젝트 referenceRepo(레포 경로/URL)를 스캔해 앱 구조·라우트·화면을 파악하고, AI가 스텝을 더 정확히 해석하도록 코드 맥락을 만듭니다(AI 플랜 생성에만 사용).",
		codeContextPlaceholder: "예: React SPA. 라우트 /orders, /settings. 로그인은 /auth/login. 목록은 <OrdersTable>로 렌더.",
		saveCodeContext: "코드 컨텍스트 저장",
		repoButton: "레포 코드 분석",
		repoRunning: "레포를 분석하는 중…",
		repoNote: "referenceRepo를 얕게 클론(또는 로컬 경로 사용)해 AGENTS.md·README·스크립트·라우트·컴포넌트를 스캔합니다. CodeGraph가 설치돼 있으면 자동으로 함께 사용하고, 없으면 파일 스캔만 씁니다(옵션). 결과는 위 코드 컨텍스트 칸에 채워지며 저장 전에 검토하세요.",
		repoDone: (files: number, cg: boolean) => `파일 ${files}개 스캔${cg ? " · CodeGraph 사용" : ""} — 검토 후 저장`,
		repoFailed: (msg: string) => `레포 분석 실패: ${msg} — referenceRepo 경로/권한과 모델 연결을 확인하세요.`,
		needRepo: "프로젝트에 referenceRepo 설정이 필요합니다",
		repoTokenPlaceholder: "비공개 레포 토큰(선택) — 저장 안 함, 이번 분석에만 사용",
		repoRefreshLabel: "새로 클론",
	},
	en: {
		sectionTitle: "Rules & Interpretation",
		noSheetSelected: "No sheet selected",
		ruleVersion: (n: number) => `Rule v${n}`,
		needProjectWithSource: "Select a project with a test source first.",
		analyzing: "AI is interpreting sheet headers…",
		headers: (h: string) => `Headers: ${h}`,
		analyzeFailed: (msg: string) => `Sheet interpretation failed: ${msg} — check the source and model connection, then retry.`,
		refining: "AI is refining rules…",
		refineUpdated: (v: number) => `Rule v${v} updated · `,
		refineNoChange: "No change · ",
		refineFailed: (msg: string) => `Rule refine failed: ${msg} — resend or check the model connection.`,
		resetConfirm: "This discards all refined rules and reverts to the default behavior dictionary. Continue?",
		resetFailed: (msg: string) => `Reset failed: ${msg}`,
		interpretStatus: "Sheet interpretation status",
		interpretLabel: "Sheet interpretation",
		columnMapping: "Column mapping",
		reanalyze: "Re-analyze",
		needModelConn: "Model connection required",
		mappingNote: "The AI-suggested column mapping is saved only for this sheet.",
		noMapping: "No saved mapping",
		noMappingNote: "Currently using automatic header detection.",
		currentRule: "Current rule",
		defaultDictInUse: "Using default behavior dictionary",
		conversationalEdit: "Conversational edit",
		refineRules: "Refine rules",
		reset: "Reset",
		conversationNote: "Add interpretation rules in natural language or revert previous instructions. Changes are kept as versions.",
		modelNotConnected: "Model not connected — sheet interpretation and rule refinement need a model.",
		connectModel: "Connect model",
		noRefinedYet: "No refined rules yet",
		exampleRefine: "e.g. “treat 누르기 as click too”",
		ruleInstruction: "Rule instruction",
		instructionPlaceholder: "Describe the rule in natural language",
		applying: "Applying",
		applyRule: "Apply rule",
		appContextTitle: "AI domain context",
		appContextNote: "Describe the app / terminology so AI interprets this sheet's steps better (used only for AI plan authoring).",
		appContextPlaceholder: "e.g. Banking dashboard. '확인' = submit button. Login at /auth. Lists render as tables.",
		saveContext: "Save context",
		savingContext: "Saving",
		contextSaved: "Saved",
		contextSaveFailed: (msg: string) => `Save failed: ${msg}`,
		reconButton: "Analyze live app",
		reconDeepLabel: "Include sub-pages",
		reconRunning: "Reconning the live app…",
		reconNote: "Visits the sheet's baseUrl, scans its structure (nav / forms / tables), and drafts domain context. If an account is linked it also attempts login. The result fills the context box above — review before saving.",
		reconDone: (n: number, logged: boolean) => `Scanned ${n} page(s)${logged ? " · logged in" : ""} — review, then save`,
		reconFailed: (msg: string) => `App analysis failed: ${msg} — check the address, account, and model connection, then retry.`,
		codeContextTitle: "AI code context",
		codeContextNote: "Scans the project's referenceRepo (path/URL) to learn app structure, routes, and screens, giving AI code context so it interprets steps more accurately (used only for AI plan authoring).",
		codeContextPlaceholder: "e.g. React SPA. Routes /orders, /settings. Login at /auth/login. Lists render via <OrdersTable>.",
		saveCodeContext: "Save code context",
		repoButton: "Analyze repo",
		repoRunning: "Analyzing the repo…",
		repoNote: "Shallow-clones the referenceRepo (or uses a local path) and scans AGENTS.md / README / scripts / routes / components. If CodeGraph is installed it is used automatically; otherwise the file scan stands alone (optional). The result fills the code-context box above — review before saving.",
		repoDone: (files: number, cg: boolean) => `Scanned ${files} file(s)${cg ? " · CodeGraph used" : ""} — review, then save`,
		repoFailed: (msg: string) => `Repo analysis failed: ${msg} — check the referenceRepo path/permissions and model connection.`,
		needRepo: "Set a referenceRepo on the project first",
		repoTokenPlaceholder: "Private repo token (optional) — not stored, used only for this run",
		repoRefreshLabel: "Re-clone",
	},
} as const;

export function RulesPanel({
	status,
	selId,
	project,
	selSheetId,
	connected,
	onStatus,
	goToModel,
}: {
	status: Status | null;
	selId: string;
	project?: Project;
	selSheetId: string;
	connected: boolean;
	onStatus: (s: Status) => void;
	goToModel: () => void;
}) {
	const t = S[useLang()];
	const [instruction, setInstruction] = useState("");
	const [busy, setBusy] = useState(false);
	const [refineMsg, setRefineMsg] = useState("");
	const [refineErr, setRefineErr] = useState(false);
	const [analyzeMsg, setAnalyzeMsg] = useState("");
	const [analyzeErr, setAnalyzeErr] = useState(false);
	const [appCtx, setAppCtx] = useState(status?.appContext ?? "");
	const [ctxBusy, setCtxBusy] = useState(false);
	const [ctxMsg, setCtxMsg] = useState("");
	const [reconBusy, setReconBusy] = useState(false);
	const [reconDeep, setReconDeep] = useState(false);
	const [reconMsg, setReconMsg] = useState("");
	const [reconErr, setReconErr] = useState(false);
	const [codeCtx, setCodeCtx] = useState(status?.codeContext ?? "");
	const [codeCtxBusy, setCodeCtxBusy] = useState(false);
	const [codeCtxMsg, setCodeCtxMsg] = useState("");
	const [repoBusy, setRepoBusy] = useState(false);
	const [repoMsg, setRepoMsg] = useState("");
	const [repoErr, setRepoErr] = useState(false);
	const [repoToken, setRepoToken] = useState("");
	const [repoRefresh, setRepoRefresh] = useState(false);

	const chat = status?.chat ?? [];
	const mapping = status?.mapping ?? {};
	const intents = status?.intents ?? {};
	const warnings = status?.warnings ?? [];
	const ruleVersion = status?.ruleVersion ?? 1;
	const sheet = project?.sheets.find((item) => item.id === selSheetId) ?? project?.sheets[0];

	useEffect(() => {
		setAppCtx(status?.appContext ?? "");
	}, [status?.appContext, selSheetId]);

	useEffect(() => {
		setCodeCtx(status?.codeContext ?? "");
	}, [status?.codeContext, selSheetId]);

	async function saveContext() {
		setCtxBusy(true);
		try {
			onStatus(await api.setRuleContext(appCtx, selId, selSheetId));
			setCtxMsg(t.contextSaved);
		} catch (e) {
			setCtxMsg(t.contextSaveFailed((e as Error).message));
		} finally {
			setCtxBusy(false);
		}
	}

	async function saveCodeContext() {
		setCodeCtxBusy(true);
		try {
			onStatus(await api.setRuleCodeContext(codeCtx, selId, selSheetId));
			setCodeCtxMsg(t.contextSaved);
		} catch (e) {
			setCodeCtxMsg(t.contextSaveFailed((e as Error).message));
		} finally {
			setCodeCtxBusy(false);
		}
	}

	async function analyzeRepo() {
		if (!project?.referenceRepo?.trim()) {
			setRepoErr(true);
			setRepoMsg(t.needRepo);
			return;
		}
		setRepoBusy(true);
		setRepoErr(false);
		setRepoMsg(t.repoRunning);
		try {
			const d = await api.analyzeRepo({
				projectId: selId,
				sheetId: selSheetId,
				token: repoToken.trim() || undefined,
				refresh: repoRefresh,
			});
			if (d.context) {
				setCodeCtx(d.context);
				setCodeCtxMsg("");
			}
			setRepoMsg([t.repoDone(d.digest.fileCount, d.codegraph), ...d.notes].join(" · "));
		} catch (e) {
			setRepoErr(true);
			setRepoMsg(t.repoFailed((e as Error).message));
		} finally {
			setRepoBusy(false);
		}
	}

	async function analyzeApp() {
		if (!sheet) {
			setReconErr(true);
			setReconMsg(t.needProjectWithSource);
			return;
		}
		setReconBusy(true);
		setReconErr(false);
		setReconMsg(t.reconRunning);
		try {
			const d = await api.analyzeApp({ projectId: selId, sheetId: sheet.id, deep: reconDeep });
			if (d.context) {
				setAppCtx(d.context);
				setCtxMsg("");
			}
			setReconMsg([t.reconDone(d.pages.length, d.loggedIn), ...d.notes].join(" · "));
		} catch (e) {
			setReconErr(true);
			setReconMsg(t.reconFailed((e as Error).message));
		} finally {
			setReconBusy(false);
		}
	}

	async function analyze() {
		if (!sheet) {
			setAnalyzeMsg(t.needProjectWithSource);
			return;
		}
		setBusy(true);
		setAnalyzeErr(false);
		setAnalyzeMsg(t.analyzing);
		try {
			const d = await api.analyze(
				sheet.kind === "sheet"
					? { sheetUrl: sheet.sheetUrl, projectId: selId, sheetId: sheet.id }
					: { csvText: sheet.csvText, projectId: selId, sheetId: sheet.id },
			);
			setAnalyzeMsg(t.headers(d.headers.join(", ")));
			onStatus(await api.status(selId, selSheetId));
		} catch (e) {
			setAnalyzeErr(true);
			setAnalyzeMsg(t.analyzeFailed((e as Error).message));
		} finally {
			setBusy(false);
		}
	}

	async function send() {
		if (!instruction.trim()) return;
		setBusy(true);
		setRefineErr(false);
		setRefineMsg(t.refining);
		try {
			const d = await api.refine(instruction, selId, selSheetId);
			setInstruction("");
			const diff = Object.entries(d.diff)
				.map(([k, v]) => `${k} ${v.added.length ? `+${v.added.join(",")}` : ""}${v.removed.length ? ` -${v.removed.join(",")}` : ""}`)
				.join("   ");
			setRefineMsg((d.changed ? t.refineUpdated(d.ruleVersion) : t.refineNoChange) + diff);
			onStatus(await api.status(selId, selSheetId));
		} catch (e) {
			setRefineErr(true);
			setRefineMsg(t.refineFailed((e as Error).message));
		} finally {
			setBusy(false);
		}
	}

	async function reset() {
		if (!window.confirm(t.resetConfirm)) return;
		try {
			onStatus(await api.refineReset(selId, selSheetId));
			setRefineMsg("");
		} catch (e) {
			setRefineErr(true);
			setRefineMsg(t.resetFailed((e as Error).message));
		}
	}

	return (
		<section>
			<div className="dash-head">
				<h2 className="sec">{t.sectionTitle}</h2>
				<span className="ctx">{sheet?.name ?? t.noSheetSelected} · {t.ruleVersion(ruleVersion)}</span>
			</div>

			<div className="rules-workspace">
				<aside className="rules-summary" aria-label={t.interpretStatus}>
					<div className="rule-section-head">
						<div>
							<p className="section-label">{t.interpretLabel}</p>
							<h3>{t.columnMapping}</h3>
						</div>
						<button className="button secondary compact" type="button" disabled={busy || !connected} title={connected ? undefined : t.needModelConn} onClick={analyze}>
							{t.reanalyze}
						</button>
					</div>
					<p className="detail">{t.mappingNote}</p>
					{Object.keys(mapping).length ? (
						<dl className="mapping-list">
							{Object.entries(mapping).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
						</dl>
					) : (
						<div className="mapping-empty">{t.noMapping}<br /><span>{t.noMappingNote}</span></div>
					)}
					{analyzeMsg && <div className={`inline-status${analyzeErr ? " error" : ""}`} role={analyzeErr ? "alert" : "status"}>{analyzeMsg}</div>}
					<div className="rule-version">
						<span>{t.currentRule}</span>
						<b>v{ruleVersion}</b>
						<p>{Object.entries(intents).map(([key, value]) => `${key}: ${value.join(", ")}`).join(" · ") || t.defaultDictInUse}</p>
					</div>
					<div className="rule-context">
						<span className="section-label">{t.appContextTitle}</span>
						<p className="detail">{t.appContextNote}</p>
						<textarea rows={4} value={appCtx} onChange={(event) => { setAppCtx(event.target.value); setCtxMsg(""); }} placeholder={t.appContextPlaceholder} />
						<div className="editor-actions" style={{ marginTop: 8 }}>
							<button className="button secondary compact" type="button" disabled={ctxBusy || appCtx === (status?.appContext ?? "")} onClick={saveContext}>{ctxBusy ? t.savingContext : t.saveContext}</button>
							{ctxMsg && <span className="muted" style={{ fontSize: 12 }}>{ctxMsg}</span>}
						</div>
						<div className="editor-actions" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
							<button className="button secondary compact" type="button" disabled={reconBusy || !connected} title={connected ? undefined : t.needModelConn} onClick={analyzeApp}>{reconBusy ? t.reconRunning : t.reconButton}</button>
							<label className="muted" style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
								<input type="checkbox" checked={reconDeep} onChange={(event) => setReconDeep(event.target.checked)} /> {t.reconDeepLabel}
							</label>
						</div>
						<p className="detail">{t.reconNote}</p>
						{reconMsg && <div className={`inline-status${reconErr ? " error" : ""}`} role={reconErr ? "alert" : "status"}>{reconMsg}</div>}
					</div>
					<div className="rule-context">
						<span className="section-label">{t.codeContextTitle}</span>
						<p className="detail">{t.codeContextNote}</p>
						<textarea rows={4} value={codeCtx} onChange={(event) => { setCodeCtx(event.target.value); setCodeCtxMsg(""); }} placeholder={t.codeContextPlaceholder} />
						<div className="editor-actions" style={{ marginTop: 8 }}>
							<button className="button secondary compact" type="button" disabled={codeCtxBusy || codeCtx === (status?.codeContext ?? "")} onClick={saveCodeContext}>{codeCtxBusy ? t.savingContext : t.saveCodeContext}</button>
							{codeCtxMsg && <span className="muted" style={{ fontSize: 12 }}>{codeCtxMsg}</span>}
						</div>
						<div className="editor-actions" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
							<button className="button secondary compact" type="button" disabled={repoBusy || !connected || !project?.referenceRepo?.trim()} title={!connected ? t.needModelConn : !project?.referenceRepo?.trim() ? t.needRepo : undefined} onClick={analyzeRepo}>{repoBusy ? t.repoRunning : t.repoButton}</button>
							<label className="muted" style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
								<input type="checkbox" checked={repoRefresh} onChange={(event) => setRepoRefresh(event.target.checked)} /> {t.repoRefreshLabel}
							</label>
						</div>
						<input type="password" value={repoToken} onChange={(event) => setRepoToken(event.target.value)} placeholder={t.repoTokenPlaceholder} autoComplete="off" style={{ marginTop: 8, width: "100%" }} />
						<p className="detail">{t.repoNote}</p>
						{repoMsg && <div className={`inline-status${repoErr ? " error" : ""}`} role={repoErr ? "alert" : "status"}>{repoMsg}</div>}
					</div>
				</aside>

				<div className="rules-conversation">
					<div className="rule-section-head conversation-head">
						<div>
							<p className="section-label">{t.conversationalEdit}</p>
							<h3>{t.refineRules}</h3>
						</div>
						<button className="text-link quiet-link" type="button" onClick={reset}>{t.reset}</button>
					</div>
					<p className="detail">{t.conversationNote}</p>
					{!connected && (
						<div className="inline-status connect-note" role="status">
							{t.modelNotConnected}{" "}
							<button className="linkbtn" type="button" onClick={goToModel}>{t.connectModel}</button>
						</div>
					)}
					<div className="chatlog" aria-live="polite">
						{chat.length === 0 && (
							<div className="conversation-empty">
								<b>{t.noRefinedYet}</b>
								<span>{t.exampleRefine}</span>
							</div>
						)}
						{chat.map((message, index) => (
							<div key={index} className={`msg ${message.role === "user" ? "u" : "a"}`}>
								{message.content}
							</div>
						))}
					</div>
					<div className="warns">
						{warnings.map((warning) => <span key={warning} className="warn"><Icon name="warning" size={14} /> {warning}</span>)}
					</div>
					<label className="composer-label" htmlFor="rule-instruction">{t.ruleInstruction}</label>
					<div className="rule-composer">
						<textarea id="rule-instruction" rows={3} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder={t.instructionPlaceholder} />
						<button className="button primary" type="button" disabled={busy || !connected || !instruction.trim()} title={connected ? undefined : t.needModelConn} onClick={send}>
							{busy ? t.applying : t.applyRule}
					</button>
				</div>
					{refineMsg && <div className={`inline-status${refineErr ? " error" : ""}`} role={refineErr ? "alert" : "status"}>{refineMsg}</div>}
				</div>
			</div>
		</section>
	);
}
