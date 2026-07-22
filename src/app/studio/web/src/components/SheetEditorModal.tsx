import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { getLang, useLang } from "../i18n";
import type { AnalyzeResult, ChatMsg, PreviewResult, TestSheet } from "../types";
import { Icon } from "./Icon";
import { ModalShell } from "./ModalShell";

const FIELD_LABELS_KO: Record<string, string> = {
	id: "ID",
	title: "제목",
	step: "스텝",
	expected: "기대결과",
	priority: "우선순위",
	role: "역할",
	env: "환경",
};

const FIELD_LABELS_EN: Record<string, string> = {
	id: "ID",
	title: "Title",
	step: "Step",
	expected: "Expected",
	priority: "Priority",
	role: "Role",
	env: "Env",
};

const S = {
	ko: {
		wizardSteps: ["소스", "해석 제안", "규칙 미세조정"] as const,
		wizardAriaLabel: "새 시트 추가 단계",
		noCases: "읽을 케이스가 없습니다. 원본 내용을 확인하세요.",
		titleCol: "제목",
		stepCol: "스텝",
		expectedCol: "기대결과",
		moreCases: (n: number) => `외 ${n}개 케이스`,
		csvLoadFailed: (msg: string) => `CSV를 불러오지 못했습니다: ${msg}`,
		defaultSheetName: "시트",
		editSheetTitle: "시트 편집",
		newSheetTitle: (label: string) => `새 시트 · ${label}`,
		nameLabel: "이름",
		namePlaceholder: "예: 로그인 시나리오",
		sourceLabel: "원본",
		googleSheet: "구글 시트",
		sheetUrlLabel: "구글 시트 URL",
		csvLabel: "CSV",
		csvLoading: "불러오는 중…",
		csvPlaceholder: "Test ID,Title,Steps,Expected&#10;…",
		baseUrlLabel: "대상 URL 오버라이드 (선택)",
		envLabel: "환경 오버라이드 (선택)",
		usernameLabel: "테스트 계정 아이디 (선택)",
		passwordLabel: "테스트 계정 비밀번호 (선택)",
		usernamePlaceholder: "아이디",
		passwordPlaceholder: "비밀번호",
		save: "저장",
		cancel: "취소",
		next: "다음",
		saving: "저장 중…",
		loading: "불러오는 중…",
		analyzeFailed: (msg: string) => `해석 실패: ${msg}`,
		retry: "다시 시도",
		aiInterpreted: "AI가 이렇게 해석했어요",
		columnMapping: "열 매핑",
		unique: "고유",
		duplicates: "중복",
		prev: "이전",
		nextRuleTune: "다음: 규칙 미세조정",
		done: "완료",
		noChatYet: '아직 대화가 없습니다. 아래 입력창에 자연어로 지시하면 규칙이 다듬어집니다 — 예: "누르기도 click으로 해석해".',
		refineFailed: (msg: string) => `규칙 다듬기 실패: ${msg}`,
		refinePlaceholder: '예: "누르기도 click으로 해석해"',
		sending: "전송 중…",
		send: "보내기",
		ruleUpdated: (v: number) => `규칙 v${v} 갱신`,
		ruleVersionLabel: (v: number) => `규칙 v${v}`,
		noChange: "변경 없음",
	},
	en: {
		wizardSteps: ["Source", "Interpretation", "Rule tuning"] as const,
		wizardAriaLabel: "Add sheet steps",
		noCases: "No cases to read. Check the source content.",
		titleCol: "Title",
		stepCol: "Step",
		expectedCol: "Expected",
		moreCases: (n: number) => `+${n} more cases`,
		csvLoadFailed: (msg: string) => `Failed to load CSV: ${msg}`,
		defaultSheetName: "Sheet",
		editSheetTitle: "Edit sheet",
		newSheetTitle: (label: string) => `New sheet · ${label}`,
		nameLabel: "Name",
		namePlaceholder: "e.g. Login scenario",
		sourceLabel: "Source",
		googleSheet: "Google Sheet",
		sheetUrlLabel: "Google Sheet URL",
		csvLabel: "CSV",
		csvLoading: "Loading…",
		csvPlaceholder: "Test ID,Title,Steps,Expected&#10;…",
		baseUrlLabel: "Target URL override (optional)",
		envLabel: "Env override (optional)",
		usernameLabel: "Test account username (optional)",
		passwordLabel: "Test account password (optional)",
		usernamePlaceholder: "Username",
		passwordPlaceholder: "Password",
		save: "Save",
		cancel: "Cancel",
		next: "Next",
		saving: "Saving…",
		loading: "Loading…",
		analyzeFailed: (msg: string) => `Interpretation failed: ${msg}`,
		retry: "Retry",
		aiInterpreted: "Here's how the AI interpreted it",
		columnMapping: "Column mapping",
		unique: "Unique",
		duplicates: "Duplicates",
		prev: "Back",
		nextRuleTune: "Next: rule tuning",
		done: "Done",
		noChatYet: 'No conversation yet. Type an instruction in natural language below to refine the rules — e.g. "treat 누르기 as click too".',
		refineFailed: (msg: string) => `Rule refine failed: ${msg}`,
		refinePlaceholder: 'e.g. "treat 누르기 as click too"',
		sending: "Sending…",
		send: "Send",
		ruleUpdated: (v: number) => `Rule v${v} updated`,
		ruleVersionLabel: (v: number) => `Rule v${v}`,
		noChange: "No change",
	},
} as const;

function WizardRail({ step }: { readonly step: 1 | 2 | 3 }) {
	const t = S[useLang()];
	const items: [1 | 2 | 3, string][] = [
		[1, t.wizardSteps[0]],
		[2, t.wizardSteps[1]],
		[3, t.wizardSteps[2]],
	];
	return (
		<ol className="run-rail" aria-label={t.wizardAriaLabel}>
			{items.map(([n, label]) => (
				<li key={n} className={`rail-step ${step > n ? "complete" : step === n ? "active" : ""}`}>
					<span className="rail-node">{step > n ? <Icon name="check" size={15} /> : n}</span>
					<div>
						<b>{n} {label}</b>
					</div>
				</li>
			))}
		</ol>
	);
}

function InterpretationPreview({ preview }: { readonly preview: PreviewResult }) {
	const t = S[useLang()];
	if (preview.unique.length === 0) {
		return <div className="muted">{t.noCases}</div>;
	}
	return (
		<div className="tscroll">
			<table>
				<thead>
					<tr>
						<th>{t.titleCol}</th>
						<th>{t.stepCol}</th>
						<th>{t.expectedCol}</th>
					</tr>
				</thead>
				<tbody>
					{preview.unique.slice(0, 20).map((testCase) => (
						<tr key={testCase.caseId}>
							<td>{testCase.title || testCase.caseId}</td>
							<td className="detail">{testCase.steps.join(" · ")}</td>
							<td className="detail">{testCase.expected}</td>
						</tr>
					))}
				</tbody>
			</table>
			{preview.unique.length > 20 && <p className="table-foot">{t.moreCases(preview.unique.length - 20)}</p>}
		</div>
	);
}

export function SheetEditorModal({
	editSheet,
	projectId,
	onSave,
	onPersist,
	onClose,
}: {
	editSheet: TestSheet | null;
	projectId: string;
	onSave: (sheet: TestSheet) => void;
	onPersist: (sheet: TestSheet) => Promise<void>;
	onClose: () => void;
}) {
	const lang = useLang();
	const t = S[lang];
	const fieldLabels = lang === "ko" ? FIELD_LABELS_KO : FIELD_LABELS_EN;
	const [name, setName] = useState(editSheet?.name ?? "");
	const [kind, setKind] = useState<"sheet" | "csv">(editSheet?.kind ?? "sheet");
	const [sheetUrl, setSheetUrl] = useState(editSheet?.sheetUrl ?? "");
	const [csvText, setCsvText] = useState(editSheet?.csvText ?? "");
	const [baseUrl, setBaseUrl] = useState(editSheet?.baseUrl ?? "");
	const [env, setEnv] = useState(editSheet?.env ?? "");
	const [username, setUsername] = useState(editSheet?.username ?? "");
	const [password, setPassword] = useState(editSheet?.password ?? "");
	const [loadingCsv, setLoadingCsv] = useState(false);
	const [loadError, setLoadError] = useState("");

	// Existing csv sheets no longer carry csvText from the projects list (it now lives in a file); fetch on demand.
	useEffect(() => {
		if (editSheet && editSheet.kind === "csv" && !editSheet.csvText && projectId) {
			setLoadingCsv(true);
			setLoadError("");
			let live = true;
			api
				.sheetContent(projectId, editSheet.id)
				.then((r) => {
					if (live) setCsvText(r.csvText);
				})
				.catch((error) => {
					if (live) setLoadError(S[getLang()].csvLoadFailed((error as Error).message));
				})
				.finally(() => {
					if (live) setLoadingCsv(false);
				});
			return () => {
				live = false;
			};
		}
	}, [editSheet, projectId]);

	function save() {
		if (!editSheet) return;
		const sheet: TestSheet = {
			...editSheet,
			name: name.trim() || editSheet.name,
			sheetUrl,
			csvText,
			baseUrl: baseUrl || undefined,
			env: env || undefined,
			username: username || undefined,
			password: password || undefined,
		};
		onSave(sheet);
	}

	// ---- New-sheet onboarding wizard state (only used when editSheet == null) ----
	const [sheetId] = useState(() => `sh_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
	const [step, setStep] = useState<1 | 2 | 3>(1);
	const [persistBusy, setPersistBusy] = useState(false);
	const [persistError, setPersistError] = useState("");

	const [interpretLoading, setInterpretLoading] = useState(false);
	const [interpretError, setInterpretError] = useState("");
	const [analyzeResult, setAnalyzeResult] = useState<AnalyzeResult | null>(null);
	const [preview, setPreview] = useState<PreviewResult | null>(null);

	const [messages, setMessages] = useState<ChatMsg[]>([]);
	const [ruleVersion, setRuleVersion] = useState(1);
	const [instruction, setInstruction] = useState("");
	const [refineBusy, setRefineBusy] = useState(false);
	const [refineError, setRefineError] = useState("");
	const [refineNote, setRefineNote] = useState("");

	const buildSheet = useCallback(
		(): TestSheet => ({
			id: sheetId,
			name: name.trim() || S[getLang()].defaultSheetName,
			kind,
			sheetUrl,
			csvText,
			baseUrl: baseUrl || undefined,
			env: env || undefined,
			username: username || undefined,
			password: password || undefined,
		}),
		[sheetId, name, kind, sheetUrl, csvText, baseUrl, env, username, password],
	);

	const loadInterpretation = useCallback(() => {
		const sheet = buildSheet();
		setInterpretLoading(true);
		setInterpretError("");
		Promise.all([
			api.analyze({ sheetUrl: kind === "sheet" ? sheetUrl : undefined, csvText: kind === "csv" ? csvText : undefined, projectId, sheetId }),
			api.preview({ sample: false, sheets: [sheet], sheetId, baseUrl: baseUrl || undefined, projectId }),
		])
			.then(([analyzeRes, previewRes]) => {
				setAnalyzeResult(analyzeRes);
				setPreview(previewRes);
				setRuleVersion(analyzeRes.ruleVersion);
				if (analyzeRes.chat?.length) setMessages(analyzeRes.chat);
			})
			.catch((error) => setInterpretError((error as Error).message))
			.finally(() => setInterpretLoading(false));
	}, [buildSheet, kind, sheetUrl, csvText, projectId, sheetId, baseUrl]);

	useEffect(() => {
		if (!editSheet && step === 2) loadInterpretation();
		// step change alone should trigger the load; loadInterpretation is intentionally excluded to avoid re-firing on every keystroke.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [step, editSheet]);

	const canProceedStep1 = name.trim().length > 0 && (kind === "sheet" ? sheetUrl.trim().length > 0 : csvText.trim().length > 0);

	async function goToStep2() {
		if (!canProceedStep1 || persistBusy) return;
		setPersistBusy(true);
		setPersistError("");
		try {
			await onPersist(buildSheet());
			setStep(2);
		} catch (error) {
			setPersistError((error as Error).message);
		} finally {
			setPersistBusy(false);
		}
	}

	async function sendRefine() {
		if (!instruction.trim() || refineBusy) return;
		const text = instruction.trim();
		setRefineBusy(true);
		setRefineError("");
		setMessages((prev) => [...prev, { role: "user", content: text }]);
		setInstruction("");
		try {
			const result = await api.refine(text, projectId, sheetId);
			setMessages((prev) => [...prev, { role: "assistant", content: result.message }]);
			setRuleVersion(result.ruleVersion);
			setRefineNote(result.changed ? S[getLang()].ruleUpdated(result.ruleVersion) : S[getLang()].noChange);
		} catch (error) {
			setRefineError((error as Error).message);
		} finally {
			setRefineBusy(false);
		}
	}

	// ---- Edit mode: unchanged single-step form ----
	if (editSheet) {
		return (
			<ModalShell label={t.defaultSheetName} onClose={onClose}>
				<h2 className="sec">{t.editSheetTitle}</h2>
				<div className="card">
					<label htmlFor="sheet-name">{t.nameLabel}</label>
					<input id="sheet-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t.namePlaceholder} />

					{editSheet.kind === "sheet" ? (
						<>
							<label htmlFor="sheet-url" style={{ marginTop: 10 }}>{t.sheetUrlLabel}</label>
							<input id="sheet-url" type="text" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
						</>
					) : (
						<>
							<label htmlFor="sheet-csv" style={{ marginTop: 10 }}>{t.csvLabel}</label>
							<textarea
								id="sheet-csv"
								rows={4}
								value={csvText}
								onChange={(e) => setCsvText(e.target.value)}
								placeholder={loadingCsv ? t.csvLoading : t.csvPlaceholder}
								disabled={loadingCsv || Boolean(loadError)}
							/>
							{loadError && <p className="err" role="alert">{loadError}</p>}
						</>
					)}

					<label htmlFor="sheet-base-url" style={{ marginTop: 10 }}>{t.baseUrlLabel}</label>
					<input id="sheet-base-url" type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your.app" />

					<label htmlFor="sheet-env" style={{ marginTop: 10 }}>{t.envLabel}</label>
					<input id="sheet-env" type="text" value={env} onChange={(e) => setEnv(e.target.value)} placeholder="staging" />

					<label htmlFor="sheet-username" style={{ marginTop: 10 }}>{t.usernameLabel}</label>
					<input id="sheet-username" type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder={t.usernamePlaceholder} autoComplete="off" />

					<label htmlFor="sheet-password" style={{ marginTop: 10 }}>{t.passwordLabel}</label>
					<input id="sheet-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t.passwordPlaceholder} autoComplete="off" />

					<div className="editor-actions" style={{ marginTop: 14 }}>
						<button className="run" style={{ marginTop: 0 }} type="button" disabled={loadingCsv || Boolean(loadError)} onClick={save}>
							{t.save}
						</button>
						<button className="button secondary" type="button" onClick={onClose}>{t.cancel}</button>
					</div>
				</div>
			</ModalShell>
		);
	}

	// ---- New mode: 3-step onboarding wizard ----
	const stepLabel = step === 1 ? t.wizardSteps[0] : step === 2 ? t.wizardSteps[1] : t.wizardSteps[2];

	return (
		<ModalShell label={t.defaultSheetName} onClose={onClose}>
			<h2 className="sec">{t.newSheetTitle(stepLabel)}</h2>
			<WizardRail step={step} />

			{step === 1 && (
				<div className="card">
					<label htmlFor="sheet-name">{t.nameLabel}</label>
					<input id="sheet-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t.namePlaceholder} />

					<span className="field-label" style={{ marginTop: 10 }}>{t.sourceLabel}</span>
					<div className="modes">
						<button className={kind === "sheet" ? "on" : ""} type="button" onClick={() => setKind("sheet")}>
							{t.googleSheet}
						</button>
						<button className={kind === "csv" ? "on" : ""} type="button" onClick={() => setKind("csv")}>
							CSV
						</button>
					</div>

					{kind === "sheet" ? (
						<>
							<label htmlFor="sheet-url" style={{ marginTop: 10 }}>{t.sheetUrlLabel}</label>
							<input id="sheet-url" type="text" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
						</>
					) : (
						<>
							<label htmlFor="sheet-csv" style={{ marginTop: 10 }}>{t.csvLabel}</label>
							<textarea id="sheet-csv" rows={4} value={csvText} onChange={(e) => setCsvText(e.target.value)} placeholder={t.csvPlaceholder} />
						</>
					)}

					<label htmlFor="sheet-base-url" style={{ marginTop: 10 }}>{t.baseUrlLabel}</label>
					<input id="sheet-base-url" type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your.app" />

					<label htmlFor="sheet-env" style={{ marginTop: 10 }}>{t.envLabel}</label>
					<input id="sheet-env" type="text" value={env} onChange={(e) => setEnv(e.target.value)} placeholder="staging" />

					<label htmlFor="sheet-username" style={{ marginTop: 10 }}>{t.usernameLabel}</label>
					<input id="sheet-username" type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder={t.usernamePlaceholder} autoComplete="off" />

					<label htmlFor="sheet-password" style={{ marginTop: 10 }}>{t.passwordLabel}</label>
					<input id="sheet-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t.passwordPlaceholder} autoComplete="off" />

					{persistError && <p className="err" role="alert">{persistError}</p>}

					<div className="editor-actions" style={{ marginTop: 14 }}>
						<button className="run" style={{ marginTop: 0 }} type="button" disabled={!canProceedStep1 || persistBusy} onClick={goToStep2}>
							{persistBusy ? t.saving : t.next}
						</button>
						<button className="button secondary" type="button" onClick={onClose}>{t.cancel}</button>
					</div>
				</div>
			)}

			{step === 2 && (
				<div className="card">
					{interpretLoading && (
						<div className="late">
							{[0, 1, 2].map((index) => (
								<div className="skel" style={{ height: 18, marginTop: index === 0 ? 0 : 12 }} key={index} />
							))}
							<p className="muted" style={{ marginTop: 12 }}>{t.loading}</p>
						</div>
					)}

					{!interpretLoading && interpretError && (
						<div className="err" role="alert">
							{t.analyzeFailed(interpretError)} <button className="mini" type="button" onClick={loadInterpretation}>{t.retry}</button>
						</div>
					)}

					{!interpretLoading && !interpretError && analyzeResult && preview && (
						<>
							<p className="kicker">{t.aiInterpreted}</p>
							<div className="summary">
								<b>{t.columnMapping}</b>
								{Object.entries(analyzeResult.mapping).map(([field, header]) => (
									<span className="chip" key={field}>
										{fieldLabels[field] ?? field} → {header}
									</span>
								))}
								<span className="chip">{t.unique} <b>{preview.counts.unique}</b></span>
								<span className="chip review-chip">{t.duplicates} <b>{preview.counts.duplicates}</b></span>
							</div>
							<InterpretationPreview preview={preview} />
							{analyzeResult.warnings.length > 0 && (
								<div className="warns" style={{ marginTop: 10 }}>
									{analyzeResult.warnings.map((w) => (
										<span key={w} className="warn">
											<Icon name="warning" size={14} /> {w}
										</span>
									))}
								</div>
							)}
						</>
					)}

					<div className="editor-actions" style={{ marginTop: 14 }}>
						<button className="button secondary" type="button" onClick={() => setStep(1)}>{t.prev}</button>
						<button className="run" style={{ marginTop: 0 }} type="button" onClick={() => setStep(3)}>{t.nextRuleTune}</button>
						<button className="button secondary" type="button" onClick={onClose}>{t.done}</button>
					</div>
				</div>
			)}

			{step === 3 && (
				<div className="card">
					<p className="detail">{t.ruleVersionLabel(ruleVersion)}</p>
					<div className="chatlog">
						{messages.length === 0 && (
							<div className="msg a muted">
								{t.noChatYet}
							</div>
						)}
						{messages.map((m, index) => (
							<div key={`${index}:${m.role}:${m.content}`} className={`msg ${m.role === "user" ? "u" : "a"}`}>
								{m.content}
							</div>
						))}
					</div>
					{refineNote && <p className="detail">{refineNote}</p>}
					{refineError && <p className="err" role="alert">{t.refineFailed(refineError)}</p>}
					<div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "flex-end" }}>
						<textarea
							rows={2}
							style={{ flex: 1 }}
							value={instruction}
							onChange={(e) => setInstruction(e.target.value)}
							placeholder={t.refinePlaceholder}
						/>
						<button className="run" style={{ marginTop: 0 }} type="button" disabled={refineBusy || !instruction.trim()} onClick={sendRefine}>
							{refineBusy ? t.sending : t.send}
						</button>
					</div>

					<div className="editor-actions" style={{ marginTop: 14 }}>
						<button className="button secondary" type="button" onClick={() => setStep(2)}>{t.prev}</button>
						<button className="button primary" type="button" onClick={onClose}>{t.done}</button>
					</div>
				</div>
			)}
		</ModalShell>
	);
}
