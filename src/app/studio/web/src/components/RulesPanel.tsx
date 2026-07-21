import { useState } from "react";
import { api } from "../api";
import type { Project, Status } from "../types";
import { Icon } from "./Icon";

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
	void connected;
	void goToModel;
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

	async function analyze() {
		const src = project?.sheets?.find((s) => s.id === selSheetId) ?? project?.sheets?.[0];
		if (!src) {
			setAnalyzeMsg("테스트 원본이 있는 프로젝트를 먼저 선택하세요.");
			return;
		}
		setBusy(true);
		setAnalyzeErr(false);
		setAnalyzeMsg("시트 헤더를 AI가 해석하는 중…");
		try {
			const d = await api.analyze(
				src.kind === "sheet"
					? { sheetUrl: src.sheetUrl, projectId: selId, sheetId: src.id }
					: { csvText: src.csvText, projectId: selId, sheetId: src.id },
			);
			setAnalyzeMsg(`헤더: ${d.headers.join(", ")}`);
			onStatus(await api.status(selId, selSheetId));
		} catch (e) {
			setAnalyzeErr(true);
			setAnalyzeMsg(`시트 해석 실패: ${(e as Error).message} — 원본과 모델 연결을 확인한 뒤 다시 시도하세요.`);
		} finally {
			setBusy(false);
		}
	}

	async function send() {
		if (!instruction.trim()) return;
		setBusy(true);
		setRefineErr(false);
		setRefineMsg("AI가 규칙을 다듬는 중…");
		try {
			const d = await api.refine(instruction, selId, selSheetId);
			setInstruction("");
			const diff = Object.entries(d.diff)
				.map(([k, v]) => `${k} ${v.added.length ? `+${v.added.join(",")}` : ""}${v.removed.length ? ` -${v.removed.join(",")}` : ""}`)
				.join("   ");
			setRefineMsg((d.changed ? `규칙 v${d.ruleVersion} 갱신 · ` : "변경 없음 · ") + diff);
			onStatus(await api.status(selId, selSheetId));
		} catch (e) {
			setRefineErr(true);
			setRefineMsg(`규칙 다듬기 실패: ${(e as Error).message} — 다시 보내거나 모델 연결 상태를 확인하세요.`);
		} finally {
			setBusy(false);
		}
	}

	async function reset() {
		try {
			onStatus(await api.refineReset(selId, selSheetId));
			setRefineMsg("");
		} catch (e) {
			setRefineErr(true);
			setRefineMsg(`초기화 실패: ${(e as Error).message}`);
		}
	}

	return (
		<section>
			<h2 className="sec">AI 규칙 다듬기 (대화)</h2>
			<div className="card">
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
					<b>시트 해석 (열 매핑)</b>
					<button className="mini" type="button" disabled={busy} onClick={analyze}>
						선택 프로젝트 시트 AI 해석
					</button>
				</div>
				<div className="detail" style={{ marginTop: 6 }}>
					{Object.keys(mapping).length
						? Object.entries(mapping)
								.map(([k, v]) => `${k}→${v}`)
								.join("   ")
						: "(매핑 없음 — 헤더 자동감지 사용)"}
				</div>
				<div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
					AI 열 매핑은 <b>이 시트</b>에 저장됩니다 (프로젝트 규칙과 별개).
				</div>
				{analyzeMsg && (
					<div className={analyzeErr ? "err" : "muted"} style={{ marginTop: 4, fontSize: 12.5 }}>
						{analyzeMsg}
					</div>
				)}
				<hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "14px 0" }} />
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
					<label htmlFor="rule-instruction" style={{ margin: 0 }}>
						지시 <span className="muted">예: "누르기도 click으로", "그건 되돌려"</span>
					</label>
					<button className="linkbtn" type="button" onClick={reset}>
						초기화
					</button>
				</div>
				<div className="chatlog">
					{chat.length === 0 && (
						<div className="msg a muted">
							아직 대화가 없습니다. 아래 입력창에 자연어로 지시하면 규칙이 버전으로 쌓입니다 — 예: "누르기도 click으로 해석해".
						</div>
					)}
					{chat.map((m) => (
						<div key={`${m.role}:${m.content}`} className={`msg ${m.role === "user" ? "u" : "a"}`}>
							{m.content}
						</div>
					))}
				</div>
				<div className="warns">
					{warnings.map((w) => (
						<span key={w} className="warn">
							<Icon name="warning" size={14} /> {w}
						</span>
					))}
				</div>
				<div className="detail">
					규칙 v{ruleVersion} ·{" "}
					{Object.entries(intents)
						.map(([k, v]) => `${k}: ${v.join(", ")}`)
						.join("   ")}
				</div>
				<div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "flex-end" }}>
					<textarea
						id="rule-instruction"
						rows={2}
						style={{ flex: 1 }}
						value={instruction}
						onChange={(e) => setInstruction(e.target.value)}
						placeholder="자연어로 규칙 지시…"
					/>
					<button className="run" style={{ marginTop: 0 }} type="button" disabled={busy} onClick={send}>
						보내기
					</button>
				</div>
				{refineMsg && <div className={refineErr ? "err" : "muted"} style={{ fontSize: 12.5 }}>{refineMsg}</div>}
			</div>
		</section>
	);
}
