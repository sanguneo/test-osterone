/**
 * OAuth-proxy model client (ChatGPT/Codex). An OAuth login token is NOT valid
 * against the billing-gated /v1/chat/completions API; it must go to the Responses
 * API at <baseUrl>/codex/responses with the ChatGPT identity headers. This lets a
 * user drive models via their ChatGPT/Codex login instead of a billed API key.
 * Implements the same `ModelClient` seam as `ApiKeyModelClient`.
 */

import type { ModelClient, ModelMessage } from "./model-client.ts";

export interface OAuthProxyOptions {
	accessToken: string;
	baseUrl?: string;
	model: string;
	reasoning?: string;
	fetchImpl?: typeof fetch;

	originator?: string;
}

const ACCOUNT_HEADER = "chatgpt-account-id";

export function codexResponsesUrl(base: string): string {
	const b = base.replace(/\/+$/, "");
	if (b.endsWith("/codex/responses")) return b;
	if (b.endsWith("/codex")) return `${b}/responses`;
	return `${b}/codex/responses`;
}

export function getCodexAccountId(accessToken: string): string | undefined {
	const parts = accessToken.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf-8")) as Record<string, unknown>;
		const auth = payload["https://api.openai.com/auth"] as { chatgpt_account_id?: string } | undefined;
		return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
	} catch {
		return undefined;
	}
}

function responsesOutputText(response: Record<string, unknown>): string {
	const output = Array.isArray(response.output) ? (response.output as Record<string, unknown>[]) : [];
	let text = "";
	for (const item of output) {
		const content = Array.isArray(item.content) ? (item.content as Record<string, unknown>[]) : [];
		for (const part of content) {
			if (part.type === "output_text" && typeof part.text === "string") text += part.text;
		}
	}
	return text;
}

/** Aggregate a Responses-API SSE stream body into a single text string. */
export function parseResponsesSse(body: string): string {
	let delta = "";
	let final = "";
	for (const line of body.split(/\r?\n/)) {
		const m = /^data:\s?(.*)$/.exec(line);
		if (!m) continue;
		const data = m[1];
		if (!data || data === "[DONE]") continue;
		let ev: Record<string, unknown>;
		try {
			ev = JSON.parse(data) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") delta += ev.delta;
		else if ((ev.type === "response.completed" || ev.type === "response.done") && ev.response) {
			final = responsesOutputText(ev.response as Record<string, unknown>);
		}
	}
	return delta || final;
}

export class OAuthProxyModelClient implements ModelClient {
	private readonly url: string;
	private readonly accessToken: string;
	private readonly model: string;
	private readonly fetchImpl: typeof fetch;

	private readonly originator: string;
	private readonly reasoning?: string;

	constructor(opts: OAuthProxyOptions) {
		this.url = codexResponsesUrl(opts.baseUrl ?? "https://chatgpt.com/backend-api");
		this.accessToken = opts.accessToken;
		this.model = opts.model;
		this.fetchImpl = opts.fetchImpl ?? fetch;

		this.originator = opts.originator ?? "codex_cli_rs";
		this.reasoning = opts.reasoning;
	}

	async complete(messages: ModelMessage[]): Promise<string> {
		const textOf = (c: ModelMessage["content"]): string =>
			typeof c === "string"
				? c
				: c
						.filter((p) => p.type === "text")
						.map((p) => p.text)
						.join("\n");
		const instructions = messages
			.filter((m) => m.role === "system")
			.map((m) => textOf(m.content))
			.join("\n\n");
		const input = messages
			.filter((m) => m.role !== "system")
			.map((m) => {
				const textType = m.role === "assistant" ? "output_text" : "input_text";
				const content =
					typeof m.content === "string"
						? [{ type: textType, text: m.content }]
						: m.content.map((p) =>
								p.type === "image" ? { type: "input_image", image_url: p.imageUrl } : { type: textType, text: p.text },
							);
				return { type: "message", role: m.role, content };
			});

		const headers: Record<string, string> = {
			"content-type": "application/json",
			accept: "text/event-stream",
			"OpenAI-Beta": "responses=experimental",
			originator: this.originator,
			session_id: crypto.randomUUID(),
			authorization: `Bearer ${this.accessToken}`,
		};
		const accountId = getCodexAccountId(this.accessToken);
		if (accountId) headers[ACCOUNT_HEADER] = accountId;

		const res = await this.fetchImpl(this.url, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: this.model,
				...(this.reasoning ? { reasoning: { effort: this.reasoning } } : {}),
				instructions,
				input,
				stream: true,
				store: false,
			}),
		});
		if (!res.ok) throw new Error(`oauth-proxy request ${res.status}: ${(await res.text()).slice(0, 200)}`);
		return parseResponsesSse(await res.text());
	}
}
