import { useState } from "react";
import { api } from "../api";
import type { Status } from "../types";

type Mode = "codex" | "token" | "apikey";

export function ModelPanel({
	status,
	selId,
	onStatus,
	onClose,
}: {
	status: Status | null;
	selId: string;
	onStatus: (s: Status) => void;
	onClose?: () => void;
}) {
	const [mode, setMode] = useState<Mode>("codex");
	const [token, setToken] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [model, setModel] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");

	const auth = status?.auth;
	const on = !!status?.connected && !!auth;

	async function connect() {
		setBusy(true);
		setErr("");
		try {
			onStatus(await api.connect({ mode, token, apiKey, model, baseUrl, projectId: selId }));
			onClose?.();
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<section>
			<header className="modal-heading">
				<h2 className="sec">모델 연결</h2>
				<p className="muted">AI 규칙 다듬기와 스텝 해석에 사용합니다.</p>
			</header>
			<div className="card">
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
					<b>연결 방식</b>
					<span className={on ? "chip" : "chip muted"} style={{ color: on ? "var(--lime)" : undefined }}>
						{on && auth
							? `연결됨 · ${auth.mode}${auth.accountId ? ` · ${auth.accountId}` : ""} · ${auth.model}${auth.endpoint ? ` · ${auth.endpoint}` : ""}`
							: "미연결"}
					</span>
				</div>
				<div className="modes" style={{ marginTop: 12 }}>
					{(["codex", "token", "apikey"] as const).map((m) => (
						<button key={m} type="button" className={mode === m ? "on" : ""} aria-pressed={mode === m} onClick={() => setMode(m)}>
							{m === "codex" ? "Codex 로그인" : m === "token" ? "토큰 직접 입력" : "API Key / 엔드포인트"}
						</button>
					))}
				</div>
				{mode === "codex" && (
					<p className="muted" style={{ fontSize: 12.5, marginTop: 12, marginBottom: 0 }}>
						로컬 <code>codex login</code> 세션을 자동 감지합니다. 모델은 로컬 config를 따릅니다.
					</p>
				)}
				{mode === "token" && (
					<>
						<label htmlFor="model-token">ChatGPT/Codex 액세스 토큰</label>
						<input id="model-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="eyJ…" autoComplete="off" />
						<label htmlFor="token-model">모델 <span className="muted">— 선택 (기본 gpt-5.6-sol)</span></label>
						<input id="token-model" type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-5.6-sol" autoComplete="off" />
					</>
				)}
				{mode === "apikey" && (
					<>
						<label htmlFor="model-api-key">API Key</label>
						<input id="model-api-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-… / 임의 키" autoComplete="off" />
						<label htmlFor="api-model">모델 <span className="muted">— 선택 (기본 gpt-4o-mini)</span></label>
						<input id="api-model" type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o-mini / llama3.1 / …" autoComplete="off" />
						<label htmlFor="model-base-url">Base URL <span className="muted">— 선택 · OpenAI 호환 엔드포인트</span></label>
						<input id="model-base-url" type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" autoComplete="off" />
						<p className="muted" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
							Azure OpenAI · OpenRouter · Together · 로컬 vLLM/Ollama(OpenAI 호환) 등. <code>/chat/completions</code>가 붙습니다.
						</p>
					</>
				)}
				<div className="editor-actions" style={{ marginTop: 14 }}>
					<button className="run" style={{ marginTop: 0 }} type="button" disabled={busy} onClick={connect}>
						{busy ? "연결 중…" : "연결"}
					</button>
					{onClose && <button className="mini" type="button" disabled={busy} onClick={onClose}>취소</button>}
					{err && (
						<span className="err">
							{err}
						</span>
					)}
				</div>
			</div>
		</section>
	);
}
