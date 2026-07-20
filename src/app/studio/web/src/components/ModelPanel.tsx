import { useState } from "react";
import { api } from "../api";
import type { Status } from "../types";

type Mode = "codex" | "token" | "apikey";

export function ModelPanel({
	status,
	selId,
	onStatus,
}: {
	status: Status | null;
	selId: string;
	onStatus: (s: Status) => void;
}) {
	const [mode, setMode] = useState<Mode>("codex");
	const [token, setToken] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");

	const auth = status?.auth;
	const on = !!status?.connected && !!auth;

	async function connect() {
		setBusy(true);
		setErr("");
		try {
			onStatus(await api.connect({ mode, token, apiKey, projectId: selId }));
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<section>
			<h2 className="sec">
				모델 연결 <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>· AI 규칙 다듬기 / AI 스텝 해석용</span>
			</h2>
			<div className="card">
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
					<b>연결 방식</b>
					<span className={on ? "chip" : "chip muted"} style={{ color: on ? "var(--lime)" : undefined }}>
						{on && auth
							? `연결됨 · ${auth.mode}${auth.accountId ? ` · ${auth.accountId}` : ""} · ${auth.model}`
							: "미연결"}
					</span>
				</div>
				<div className="modes" style={{ marginTop: 12 }}>
					{(["codex", "token", "apikey"] as const).map((m) => (
						<button key={m} type="button" className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
							{m === "codex" ? "Codex 로그인" : m === "token" ? "토큰 직접 입력" : "API Key"}
						</button>
					))}
				</div>
				{mode === "token" && (
					<>
						<label>ChatGPT/Codex 액세스 토큰</label>
						<input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="eyJ…" autoComplete="off" />
					</>
				)}
				{mode === "apikey" && (
					<>
						<label>OpenAI API Key</label>
						<input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" autoComplete="off" />
					</>
				)}
				<div style={{ marginTop: 14 }}>
					<button className="run" style={{ marginTop: 0 }} type="button" disabled={busy} onClick={connect}>
						{busy ? "연결 중…" : "연결"}
					</button>
					{err && (
						<span className="err" style={{ marginLeft: 12 }}>
							{err}
						</span>
					)}
				</div>
			</div>
		</section>
	);
}
