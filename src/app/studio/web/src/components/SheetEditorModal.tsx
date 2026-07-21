import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { AnalyzeResult, ChatMsg, PreviewResult, TestSheet } from "../types";
import { Icon } from "./Icon";
import { ModalShell } from "./ModalShell";

const FIELD_LABELS: Record<string, string> = {
	id: "ID",
	title: "제목",
	step: "스텝",
	expected: "기대결과",
	priority: "우선순위",
	role: "역할",
	env: "환경",
};

function WizardRail({ step }: { readonly step: 1 | 2 | 3 }) {
	const items: [1 | 2 | 3, string][] = [
		[1, "소스"],
		[2, "해석 제안"],
		[3, "규칙 미세조정"],
	];
	return (
		<ol className="run-rail" aria-label="새 시트 추가 단계">
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
	if (preview.unique.length === 0) {
		return <div className="muted">읽을 케이스가 없습니다. 원본 내용을 확인하세요.</div>;
	}
	return (
		<div className="tscroll">
			<table>
				<thead>
					<tr>
						<th>제목</th>
						<th>스텝</th>
						<th>기대결과</th>
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
			{preview.unique.length > 20 && <p className="table-foot">외 {preview.unique.length - 20}개 케이스</p>}
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
	const [name, setName] = useState(editSheet?.name ?? "");
	const [kind, setKind] = useState<"sheet" | "csv">(editSheet?.kind ?? "sheet");
	const [sheetUrl, setSheetUrl] = useState(editSheet?.sheetUrl ?? "");
	const [csvText, setCsvText] = useState(editSheet?.csvText ?? "");
	const [baseUrl, setBaseUrl] = useState(editSheet?.baseUrl ?? "");
	const [env, setEnv] = useState(editSheet?.env ?? "");
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
					if (live) setLoadError(`CSV를 불러오지 못했습니다: ${(error as Error).message}`);
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
			name: name.trim() || "시트",
			kind,
			sheetUrl,
			csvText,
			baseUrl: baseUrl || undefined,
			env: env || undefined,
		}),
		[sheetId, name, kind, sheetUrl, csvText, baseUrl, env],
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
			setRefineNote(result.changed ? `규칙 v${result.ruleVersion} 갱신` : "변경 없음");
		} catch (error) {
			setRefineError((error as Error).message);
		} finally {
			setRefineBusy(false);
		}
	}

	// ---- Edit mode: unchanged single-step form ----
	if (editSheet) {
		return (
			<ModalShell label="시트" onClose={onClose}>
				<h2 className="sec">시트 편집</h2>
				<div className="card">
					<label htmlFor="sheet-name">이름</label>
					<input id="sheet-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 로그인 시나리오" />

					{editSheet.kind === "sheet" ? (
						<>
							<label htmlFor="sheet-url" style={{ marginTop: 10 }}>구글 시트 URL</label>
							<input id="sheet-url" type="text" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
						</>
					) : (
						<>
							<label htmlFor="sheet-csv" style={{ marginTop: 10 }}>CSV</label>
							<textarea
								id="sheet-csv"
								rows={4}
								value={csvText}
								onChange={(e) => setCsvText(e.target.value)}
								placeholder={loadingCsv ? "불러오는 중…" : "Test ID,Title,Steps,Expected&#10;…"}
								disabled={loadingCsv || Boolean(loadError)}
							/>
							{loadError && <p className="err" role="alert">{loadError}</p>}
						</>
					)}

					<label htmlFor="sheet-base-url" style={{ marginTop: 10 }}>대상 URL 오버라이드 (선택)</label>
					<input id="sheet-base-url" type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your.app" />

					<label htmlFor="sheet-env" style={{ marginTop: 10 }}>환경 오버라이드 (선택)</label>
					<input id="sheet-env" type="text" value={env} onChange={(e) => setEnv(e.target.value)} placeholder="staging" />

					<div className="editor-actions" style={{ marginTop: 14 }}>
						<button className="run" style={{ marginTop: 0 }} type="button" disabled={loadingCsv || Boolean(loadError)} onClick={save}>
							저장
						</button>
						<button className="mini" type="button" onClick={onClose}>취소</button>
					</div>
				</div>
			</ModalShell>
		);
	}

	// ---- New mode: 3-step onboarding wizard ----
	const stepLabel = step === 1 ? "소스" : step === 2 ? "해석 제안" : "규칙 미세조정";

	return (
		<ModalShell label="시트" onClose={onClose}>
			<h2 className="sec">새 시트 · {stepLabel}</h2>
			<WizardRail step={step} />

			{step === 1 && (
				<div className="card">
					<label htmlFor="sheet-name">이름</label>
					<input id="sheet-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 로그인 시나리오" />

					<span className="field-label" style={{ marginTop: 10 }}>원본</span>
					<div className="modes">
						<button className={kind === "sheet" ? "on" : ""} type="button" onClick={() => setKind("sheet")}>
							구글 시트
						</button>
						<button className={kind === "csv" ? "on" : ""} type="button" onClick={() => setKind("csv")}>
							CSV
						</button>
					</div>

					{kind === "sheet" ? (
						<>
							<label htmlFor="sheet-url" style={{ marginTop: 10 }}>구글 시트 URL</label>
							<input id="sheet-url" type="text" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
						</>
					) : (
						<>
							<label htmlFor="sheet-csv" style={{ marginTop: 10 }}>CSV</label>
							<textarea id="sheet-csv" rows={4} value={csvText} onChange={(e) => setCsvText(e.target.value)} placeholder="Test ID,Title,Steps,Expected&#10;…" />
						</>
					)}

					<label htmlFor="sheet-base-url" style={{ marginTop: 10 }}>대상 URL 오버라이드 (선택)</label>
					<input id="sheet-base-url" type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your.app" />

					<label htmlFor="sheet-env" style={{ marginTop: 10 }}>환경 오버라이드 (선택)</label>
					<input id="sheet-env" type="text" value={env} onChange={(e) => setEnv(e.target.value)} placeholder="staging" />

					{persistError && <p className="err" role="alert">{persistError}</p>}

					<div className="editor-actions" style={{ marginTop: 14 }}>
						<button className="run" style={{ marginTop: 0 }} type="button" disabled={!canProceedStep1 || persistBusy} onClick={goToStep2}>
							{persistBusy ? "저장 중…" : "다음"}
						</button>
						<button className="mini" type="button" onClick={onClose}>취소</button>
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
							<p className="muted" style={{ marginTop: 12 }}>불러오는 중…</p>
						</div>
					)}

					{!interpretLoading && interpretError && (
						<div className="err" role="alert">
							해석 실패: {interpretError} <button className="mini" type="button" onClick={loadInterpretation}>다시 시도</button>
						</div>
					)}

					{!interpretLoading && !interpretError && analyzeResult && preview && (
						<>
							<p className="kicker">AI가 이렇게 해석했어요</p>
							<div className="summary">
								<b>열 매핑</b>
								{Object.entries(analyzeResult.mapping).map(([field, header]) => (
									<span className="chip" key={field}>
										{FIELD_LABELS[field] ?? field} → {header}
									</span>
								))}
								<span className="chip">고유 <b>{preview.counts.unique}</b></span>
								<span className="chip review-chip">중복 <b>{preview.counts.duplicates}</b></span>
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
						<button className="mini" type="button" onClick={() => setStep(1)}>이전</button>
						<button className="run" style={{ marginTop: 0 }} type="button" onClick={() => setStep(3)}>다음: 규칙 미세조정</button>
						<button className="button secondary" type="button" onClick={onClose}>완료</button>
					</div>
				</div>
			)}

			{step === 3 && (
				<div className="card">
					<p className="detail">규칙 v{ruleVersion}</p>
					<div className="chatlog">
						{messages.length === 0 && (
							<div className="msg a muted">
								아직 대화가 없습니다. 아래 입력창에 자연어로 지시하면 규칙이 다듬어집니다 — 예: "누르기도 click으로 해석해".
							</div>
						)}
						{messages.map((m, index) => (
							<div key={`${index}:${m.role}:${m.content}`} className={`msg ${m.role === "user" ? "u" : "a"}`}>
								{m.content}
							</div>
						))}
					</div>
					{refineNote && <p className="detail">{refineNote}</p>}
					{refineError && <p className="err" role="alert">규칙 다듬기 실패: {refineError}</p>}
					<div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "flex-end" }}>
						<textarea
							rows={2}
							style={{ flex: 1 }}
							value={instruction}
							onChange={(e) => setInstruction(e.target.value)}
							placeholder={'예: "누르기도 click으로 해석해"'}
						/>
						<button className="run" style={{ marginTop: 0 }} type="button" disabled={refineBusy || !instruction.trim()} onClick={sendRefine}>
							{refineBusy ? "전송 중…" : "보내기"}
						</button>
					</div>

					<div className="editor-actions" style={{ marginTop: 14 }}>
						<button className="mini" type="button" onClick={() => setStep(2)}>이전</button>
						<button className="button primary" type="button" onClick={onClose}>완료</button>
					</div>
				</div>
			)}
		</ModalShell>
	);
}
