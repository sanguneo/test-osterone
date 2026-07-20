import { useState } from "react";
import { api } from "../api";
import type { Project, Status } from "../types";

export function RulesPanel({
	status,
	selId,
	project,
	connected,
	onStatus,
}: {
	status: Status | null;
	selId: string;
	project?: Project;
	connected: boolean;
	onStatus: (s: Status) => void;
}) {
	const [instruction, setInstruction] = useState("");
	const [busy, setBusy] = useState(false);
	const [refineMsg, setRefineMsg] = useState("");
	const [analyzeMsg, setAnalyzeMsg] = useState("");

	const chat = status?.chat ?? [];
	const mapping = status?.mapping ?? {};
	const intents = status?.intents ?? {};
	const warnings = status?.warnings ?? [];
	const ruleVersion = status?.ruleVersion ?? 1;

	if (!connected) {
		return (
			<section>
				<h2 className="sec">AI 규칙 다듬기 (대화)</h2>
				<div className="card muted">
					먼저 <b>모델 연결</b> 탭에서 모델을 연결하세요.
				</div>
			</section>
		);
	}

	async function analyze() {
		const src = project?.sources?.[0];
		if (!src) {
			setAnalyzeMsg("TC 소스가 있는 프로젝트를 먼저 선택하세요.");
			return;
		}
		setBusy(true);
		setAnalyzeMsg("시트 헤더를 AI가 해석하는 중…");
		try {
			const d = await api.analyze(
				src.kind === "sheet" ? { sheetUrl: src.sheetUrl, projectId: selId } : { csvText: src.csvText, projectId: selId },
			);
			setAnalyzeMsg(`헤더: ${d.headers.join(", ")}`);
			onStatus(await api.status(selId));
		} catch (e) {
			setAnalyzeMsg((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	async function send() {
		if (!instruction.trim()) return;
		setBusy(true);
		setRefineMsg("AI가 규칙을 다듬는 중…");
		try {
			const d = await api.refine(instruction, selId);
			setInstruction("");
			const diff = Object.entries(d.diff)
				.map(([k, v]) => `${k} ${v.added.length ? `+${v.added.join(",")}` : ""}${v.removed.length ? ` -${v.removed.join(",")}` : ""}`)
				.join("   ");
			setRefineMsg((d.changed ? `규칙 v${d.ruleVersion} 갱신 · ` : "변경 없음 · ") + diff);
			onStatus(await api.status(selId));
		} catch (e) {
			setRefineMsg((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	async function reset() {
		try {
			onStatus(await api.refineReset(selId));
			setRefineMsg("");
		} catch (e) {
			setRefineMsg((e as Error).message);
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
				{analyzeMsg && (
					<div className="muted" style={{ marginTop: 4 }}>
						{analyzeMsg}
					</div>
				)}
				<hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "14px 0" }} />
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
					<label style={{ margin: 0 }}>
						지시 <span className="muted">예: "누르기도 click으로", "그건 되돌려"</span>
					</label>
					<button className="linkbtn" type="button" onClick={reset}>
						초기화
					</button>
				</div>
				<div className="chatlog">
					{chat.map((m, i) => (
						<div key={i} className={`msg ${m.role === "user" ? "u" : "a"}`}>
							{m.content}
						</div>
					))}
				</div>
				<div className="warns">
					{warnings.map((w, i) => (
						<span key={i} className="warn">
							⚠ {w}
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
				{refineMsg && <div className="muted">{refineMsg}</div>}
			</div>
		</section>
	);
}
