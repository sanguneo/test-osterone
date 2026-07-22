import { useState } from "react";
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

	const chat = status?.chat ?? [];
	const mapping = status?.mapping ?? {};
	const intents = status?.intents ?? {};
	const warnings = status?.warnings ?? [];
	const ruleVersion = status?.ruleVersion ?? 1;
	const sheet = project?.sheets.find((item) => item.id === selSheetId) ?? project?.sheets[0];

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
