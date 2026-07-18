/**
 * Minimal model-client seam. Two implementations:
 *  - `ApiKeyModelClient`: OpenAI-style chat-completions authenticated with a plain API key (v1 baseline).
 *  - `FakeModelClient`: deterministic, offline; used by unit/integration tests.
 *
 * OAuth-proxy provisioning (ChatGPT/Codex, billing bypass) is Phase C and will
 * implement this same `ModelClient` interface — the seam stays stable.
 */

export interface ModelMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ModelClient {
	/** Single-shot completion: messages -> reply text. */
	complete(messages: ModelMessage[]): Promise<string>;
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

	constructor(opts: ApiKeyModelOptions) {
		this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
		this.apiKey = opts.apiKey;
		this.model = opts.model;
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.maxTokens = opts.maxTokens ?? 512;
	}

	async complete(messages: ModelMessage[]): Promise<string> {
		const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
			body: JSON.stringify({ model: this.model, temperature: 0, max_tokens: this.maxTokens, messages }),
		});
		if (!res.ok) {
			throw new Error(`model request failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
		}
		const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
		return String(data.choices?.[0]?.message?.content ?? "");
	}
}
