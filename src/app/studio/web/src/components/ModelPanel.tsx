import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useLang } from "../i18n";
import type { Status } from "../types";

type Mode = "codex" | "token" | "apikey";

const REASONING_ALL = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const REASONING_CHAT = ["minimal", "low", "medium", "high"] as const;

const S = {
	ko: {
		title: "모델 연결",
		subtitle: "AI 규칙 다듬기와 스텝 해석에 사용합니다.",
		connectMethod: "연결 방식",
		connected: (mode: string, accountId: string | undefined, model: string, reasoning: string | undefined, endpoint: string | undefined) =>
			`연결됨 · ${mode}${accountId ? ` · ${accountId}` : ""} · ${model}${reasoning ? ` · reasoning ${reasoning}` : ""}${endpoint ? ` · ${endpoint}` : ""}`,
		notConnected: "미연결",
		modeCodex: "ChatGPT 로그인",
		modeToken: "토큰 직접 입력",
		modeApiKey: "API Key / 엔드포인트",
		deviceOpenPrefix: "브라우저에서",
		deviceOpenSuffix: "를 열고 아래 코드를 입력·승인하세요. 승인되면 자동으로 연결됩니다.",
		modelLabel: "모델",
		optionalDefault: "— 선택 · 비우면 기본값",
		tokenLabel: "ChatGPT/Codex 액세스 토큰",
		optionalDefaultModel: "— 선택 (기본 gpt-5.6-sol)",
		apiKeyLabel: "API Key",
		apiKeyPlaceholder: "sk-… / 임의 키",
		optionalDefaultApiModel: "— 선택 (기본 gpt-4o-mini)",
		baseUrlLabel: "Base URL",
		baseUrlHint: "— 선택 · OpenAI 호환 엔드포인트",

		reasoningLabel: "추론 수준",
		reasoningHint: "— 선택 · 추론 모델에만 적용",
		reasoningHintChat: " · chat/completions는 minimal–high",
		reasoningAuto: "자동 (모델 기본값)",
		cancelLogin: "로그인 취소",
		waitingAuth: "브라우저 인증 대기 중…",
		loginWithChatGpt: "ChatGPT로 로그인",
		connecting: "연결 중…",
		connect: "연결",
		loginOtherAccount: "다른 계정으로 로그인",
		close: "닫기",
		loginTimeout: "로그인 시간이 초과됐습니다. 다시 시도하세요.",
	},
	en: {
		title: "Model connection",
		subtitle: "Used for AI rule refinement and step interpretation.",
		connectMethod: "Connection method",
		connected: (mode: string, accountId: string | undefined, model: string, reasoning: string | undefined, endpoint: string | undefined) =>
			`Connected · ${mode}${accountId ? ` · ${accountId}` : ""} · ${model}${reasoning ? ` · reasoning ${reasoning}` : ""}${endpoint ? ` · ${endpoint}` : ""}`,
		notConnected: "Not connected",
		modeCodex: "ChatGPT login",
		modeToken: "Enter token directly",
		modeApiKey: "API Key / endpoint",
		deviceOpenPrefix: "In your browser, open",
		deviceOpenSuffix: "and enter/approve the code below. Once approved, it connects automatically.",
		modelLabel: "Model",
		optionalDefault: "— optional · defaults if left blank",
		tokenLabel: "ChatGPT/Codex access token",
		optionalDefaultModel: "— optional (default gpt-5.6-sol)",
		apiKeyLabel: "API Key",
		apiKeyPlaceholder: "sk-… / any key",
		optionalDefaultApiModel: "— optional (default gpt-4o-mini)",
		baseUrlLabel: "Base URL",
		baseUrlHint: "— optional · OpenAI-compatible endpoint",
		reasoningLabel: "Reasoning level",
		reasoningHint: "— optional · applies only to reasoning models",
		reasoningHintChat: " · chat/completions supports minimal–high",
		reasoningAuto: "Auto (model default)",
		cancelLogin: "Cancel login",
		waitingAuth: "Waiting for browser auth…",
		loginWithChatGpt: "Log in with ChatGPT",
		connecting: "Connecting…",
		connect: "Connect",
		loginOtherAccount: "Log in with a different account",
		close: "Close",
		loginTimeout: "Login timed out. Please try again.",
	},
} as const;

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
	const lang = useLang();
	const t = S[lang];
	const [mode, setMode] = useState<Mode>("codex");
	const [token, setToken] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [model, setModel] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [reasoning, setReasoning] = useState("");
	const [busy, setBusy] = useState(false);
	const [device, setDevice] = useState<{ code: string; url: string } | null>(null);
	const [err, setErr] = useState("");

	const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const attempts = useRef(0);
	useEffect(() => () => { if (pollTimer.current) clearTimeout(pollTimer.current); }, []);

	const auth = status?.auth;
	const on = !!status?.connected && !!auth;
	const codexAvailable = !!status?.codexAvailable;

	async function connect() {
		setBusy(true);
		setErr("");
		try {
			onStatus(await api.connect({ mode, token, apiKey, model, baseUrl, reasoning, projectId: selId }));
			onClose?.();
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	function stopPolling() {
		if (pollTimer.current) clearTimeout(pollTimer.current);
		pollTimer.current = null;
		setDevice(null);
		setBusy(false);
	}

	function poll() {
		const tick = async () => {
			if (attempts.current++ > 120) {
				setErr(t.loginTimeout);
				stopPolling();
				return;
			}
			try {
				const res = await api.devicePoll({ projectId: selId });
				if (res.pending) {
					pollTimer.current = setTimeout(tick, 5000);
					return;
				}
				stopPolling();
				onStatus(res as Status);
				onClose?.();
			} catch (e) {
				setErr((e as Error).message);
				stopPolling();
			}
		};
		pollTimer.current = setTimeout(tick, 4000);
	}

	async function startLogin() {
		setBusy(true);
		setErr("");
		attempts.current = 0;
		try {
			const started = await api.deviceStart({ model, reasoning });
			setDevice({ code: started.userCode, url: started.url });
			try {
				window.open(started.url, "_blank", "noopener");
			} catch {}
			poll();
		} catch (e) {
			setErr((e as Error).message);
			setBusy(false);
		}
	}

	const codexLoginMode = mode === "codex" && !codexAvailable;
	const reasoningOpts = mode === "apikey" ? REASONING_CHAT : REASONING_ALL;

	return (
		<section>
			<header className="modal-heading">
				<h2 className="sec">{t.title}</h2>
				<p className="muted">{t.subtitle}</p>
			</header>
			<div className="card">
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
					<b>{t.connectMethod}</b>
					<span className={on ? "chip" : "chip muted"} style={{ color: on ? "var(--lime)" : undefined }}>
						{on && auth
							? t.connected(auth.mode, auth.accountId, auth.model, auth.reasoning, auth.endpoint)
							: t.notConnected}
					</span>
				</div>
				<div className="modes" style={{ marginTop: 12 }}>
					{(["codex", "token", "apikey"] as const).map((m) => (
						<button key={m} type="button" className={mode === m ? "on" : ""} aria-pressed={mode === m} onClick={() => { setMode(m); if (m === "apikey" && (reasoning === "xhigh" || reasoning === "max")) setReasoning(""); }}>
							{m === "codex" ? t.modeCodex : m === "token" ? t.modeToken : t.modeApiKey}
						</button>
					))}
				</div>

				{mode === "codex" && (
					<>
						{codexAvailable ? (
							<p className="muted" style={{ fontSize: 12.5, marginTop: 12, marginBottom: 0 }}>
								{lang === "ko" ? (
									<>로컬 <code>codex</code> 세션을 자동 감지했습니다. <b>연결</b>로 바로 사용하거나, 아래에서 다른 계정으로 로그인할 수 있어요.</>
								) : (
									<>Detected a local <code>codex</code> session automatically. Use <b>Connect</b> right away, or log in with a different account below.</>
								)}
							</p>
						) : (
							<div className="inline-status" style={{ marginTop: 12 }}>
								{lang === "ko" ? (
									<>ChatGPT/OpenAI 계정으로 브라우저 로그인합니다 — <b>codex 설치 불필요</b>. codex 없이 쓰려면 이 방식이나 위의 <b>API Key</b>·<b>토큰</b>을 선택하세요.</>
								) : (
									<>Log in via browser with your ChatGPT/OpenAI account — <b>no codex install needed</b>. If you'd rather skip codex, use this method or pick <b>API Key</b>/<b>token</b> above.</>
								)}
							</div>
						)}
						{device && (
							<div className="inline-status" role="status" style={{ marginTop: 12, lineHeight: 1.7 }}>
								{t.deviceOpenPrefix} <a className="text-link" href={device.url} target="_blank" rel="noopener noreferrer">{device.url}</a> {t.deviceOpenSuffix}
								<br />
								<b style={{ fontFamily: "ui-monospace, Consolas, monospace", fontSize: 18, letterSpacing: "0.12em", color: "var(--lime)" }}>{device.code}</b>
							</div>
						)}
						<label htmlFor="codex-model">{t.modelLabel} <span className="muted">{t.optionalDefault}</span></label>
						<input id="codex-model" type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-5.6-sol" autoComplete="off" />
					</>
				)}
				{mode === "token" && (
					<>
						<label htmlFor="model-token">{t.tokenLabel}</label>
						<input id="model-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="eyJ…" autoComplete="off" />
						<label htmlFor="token-model">{t.modelLabel} <span className="muted">{t.optionalDefaultModel}</span></label>
						<input id="token-model" type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-5.6-sol" autoComplete="off" />
					</>
				)}
				{mode === "apikey" && (
					<>
						<label htmlFor="model-api-key">{t.apiKeyLabel}</label>
						<input id="model-api-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={t.apiKeyPlaceholder} autoComplete="off" />
						<label htmlFor="api-model">{t.modelLabel} <span className="muted">{t.optionalDefaultApiModel}</span></label>
						<input id="api-model" type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o-mini / llama3.1 / …" autoComplete="off" />
						<label htmlFor="model-base-url">{t.baseUrlLabel} <span className="muted">{t.baseUrlHint}</span></label>
						<input id="model-base-url" type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" autoComplete="off" />
						<p className="muted" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
							{lang === "ko" ? (
								<>Azure OpenAI · OpenRouter · Together · 로컬 vLLM/Ollama(OpenAI 호환) 등. <code>/chat/completions</code>가 붙습니다.</>
							) : (
								<>Azure OpenAI · OpenRouter · Together · local vLLM/Ollama (OpenAI-compatible), etc. <code>/chat/completions</code> is appended.</>
							)}
						</p>
					</>
				)}

				<label htmlFor="model-reasoning">{t.reasoningLabel} <span className="muted">{t.reasoningHint}{mode === "apikey" ? t.reasoningHintChat : ""}</span></label>
				<select id="model-reasoning" value={reasoning} onChange={(e) => setReasoning(e.target.value)}>
					<option value="">{t.reasoningAuto}</option>
					{reasoningOpts.map((r) => (
						<option key={r} value={r}>{r}</option>
					))}
				</select>

				<div className="editor-actions" style={{ marginTop: 14 }}>
					{device ? (
						<button className="button secondary" type="button" onClick={() => { stopPolling(); setErr(""); }}>{t.cancelLogin}</button>
					) : codexLoginMode ? (
						<button className="run" style={{ marginTop: 0 }} type="button" disabled={busy} onClick={startLogin}>
							{busy ? t.waitingAuth : t.loginWithChatGpt}
						</button>
					) : (
						<button className="run" style={{ marginTop: 0 }} type="button" disabled={busy} onClick={connect}>
							{busy ? t.connecting : t.connect}
						</button>
					)}
					{mode === "codex" && codexAvailable && !device && (
						<button className="linkbtn" type="button" disabled={busy} onClick={startLogin}>{t.loginOtherAccount}</button>
					)}
					{onClose && <button className="button secondary" type="button" disabled={busy && !device} onClick={onClose}>{t.close}</button>}
					{err && <span className="err">{err}</span>}
				</div>
			</div>
		</section>
	);
}
