/**
 * Minimal model-client seam. Two implementations:
 *  - `ApiKeyModelClient`: OpenAI-style chat-completions authenticated with a plain API key (v1 baseline).
 *  - `FakeModelClient`: deterministic, offline; used by unit/integration tests.
 *
 * OAuth-proxy provisioning (ChatGPT/Codex, billing bypass) is Phase C and will
 * implement this same `ModelClient` interface — the seam stays stable.
 */

/** A single content part — text, or an image (data URL or http URL) for vision models. */
export type ContentPart = { type: "text"; text: string } | { type: "image"; imageUrl: string };

export interface ModelMessage {
	role: "system" | "user" | "assistant";
	content: string | ContentPart[];
}

/** Map neutral content to OpenAI chat-completions format (string stays as-is). */
export function toChatContent(content: string | ContentPart[]): unknown {
	if (typeof content === "string") return content;
	return content.map((p) =>
		p.type === "image" ? { type: "image_url", image_url: { url: p.imageUrl } } : { type: "text", text: p.text },
	);
}

export interface CompleteOptions {
	/**
	 * Reasoning effort to use when the connection itself does not pin one. Every call site here is a
	 * short structured task (author a plan, judge a screenshot, repair one action), and the model's
	 * own default effort costs seconds per call for no measurable quality gain — the user's explicit
	 * choice still wins over this.
	 */
	defaultEffort?: string;
	/**
	 * Hard ceiling on one request, in ms. Default `DEFAULT_REQUEST_TIMEOUT_MS`.
	 *
	 * Neither client bounded a request at all, so a call that never answers was left to undici's
	 * defaults (300s headers + 300s body). Measured: one authoring call stalled a 98-case batch for
	 * nine minutes, which alone was 27% of that run's wall clock and long enough to lose the client
	 * watching it. A model that has stopped answering is a failure, not something to wait out.
	 */
	timeoutMs?: number;
}

/**
 * Generous on purpose: high reasoning effort on a real authoring prompt legitimately takes tens of
 * seconds, and a timeout that fires on healthy work would trade a stall for silent rule-interpretation
 * fallbacks — a far worse failure, because it is invisible in the verdicts.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** Abort signal for one request, honouring an explicit override of the default ceiling. */
export function requestTimeoutSignal(opts: CompleteOptions = {}): AbortSignal {
	return AbortSignal.timeout(Math.max(1, opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS));
}

export interface ModelClient {
	/** Single-shot completion: messages -> reply text. */
	complete(messages: ModelMessage[], opts?: CompleteOptions): Promise<string>;
}

/** Deterministic, offline fake. The reply fn defaults to echoing nothing. */
export class FakeModelClient implements ModelClient {
	constructor(private readonly reply: (messages: ModelMessage[]) => string = () => "") {}

	async complete(messages: ModelMessage[]): Promise<string> {
		return this.reply(messages);
	}
}

export interface ApiKeyModelOptions {
	baseUrl?: string;
	apiKey: string;
	model: string;
	reasoning?: string;
	fetchImpl?: typeof fetch;
	maxTokens?: number;
}

/** OpenAI-style chat-completions client authenticated with a plain API key. */
export class ApiKeyModelClient implements ModelClient {
	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly model: string;
	private readonly fetchImpl: typeof fetch;
	private readonly maxTokens: number;
	private readonly reasoning?: string;

	constructor(opts: ApiKeyModelOptions) {
		this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
		this.apiKey = opts.apiKey;
		this.model = opts.model;
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.maxTokens = opts.maxTokens ?? 512;
		this.reasoning = opts.reasoning;
	}

	async complete(messages: ModelMessage[], opts: CompleteOptions = {}): Promise<string> {
		const effort = this.reasoning ?? opts.defaultEffort;
		const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
			body: JSON.stringify({
				model: this.model,
				temperature: 0,
				max_tokens: this.maxTokens,
				messages: messages.map((m) => ({ role: m.role, content: toChatContent(m.content) })),
				...(effort ? { reasoning_effort: effort } : {}),
			}),
			signal: requestTimeoutSignal(opts),
		});
		if (!res.ok) {
			throw new Error(`model request failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
		}
		const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
		return String(data.choices?.[0]?.message?.content ?? "");
	}
}
