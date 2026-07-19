import { expect, test } from "bun:test";

import {
	codexResponsesUrl,
	getCodexAccountId,
	OAuthProxyModelClient,
	parseResponsesSse,
} from "../src/model/oauth-proxy.ts";

function jwt(accountId: string): string {
	const p = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString(
		"base64url",
	);
	return `h.${p}.s`;
}

function sse(events: Record<string, unknown>[]): string {
	return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

test("codexResponsesUrl normalizes to /codex/responses", () => {
	expect(codexResponsesUrl("https://chatgpt.com/backend-api")).toBe("https://chatgpt.com/backend-api/codex/responses");
	expect(codexResponsesUrl("https://x/codex")).toBe("https://x/codex/responses");
	expect(codexResponsesUrl("https://x/codex/responses/")).toBe("https://x/codex/responses");
});

test("getCodexAccountId extracts the JWT account claim (or undefined for opaque)", () => {
	expect(getCodexAccountId(jwt("acc_1"))).toBe("acc_1");
	expect(getCodexAccountId("opaque")).toBeUndefined();
});

test("parseResponsesSse aggregates output_text deltas", () => {
	const body = sse([
		{ type: "response.output_text.delta", delta: "He" },
		{ type: "response.output_text.delta", delta: "llo" },
		{ type: "response.completed", response: { output: [] } },
	]);
	expect(parseResponsesSse(body)).toBe("Hello");
});

test("OAuthProxyModelClient routes to codex/responses with identity headers and parses SSE", async () => {
	const seen = { url: "", headers: {} as Record<string, string>, body: {} as Record<string, unknown> };
	const fetchImpl = (async (url: unknown, init?: unknown) => {
		seen.url = String(url);
		seen.headers = (init as RequestInit).headers as Record<string, string>;
		seen.body = JSON.parse(String((init as RequestInit).body));
		return new Response(
			sse([
				{ type: "response.output_text.delta", delta: "ok" },
				{ type: "response.completed", response: { output: [] } },
			]),
			{ status: 200 },
		);
	}) as unknown as typeof fetch;
	const c = new OAuthProxyModelClient({ accessToken: jwt("acc_9"), model: "gpt-5-codex", fetchImpl });
	expect(
		await c.complete([
			{ role: "system", content: "sys" },
			{ role: "user", content: "hi" },
		]),
	).toBe("ok");
	expect(seen.url).toBe("https://chatgpt.com/backend-api/codex/responses");
	expect(seen.headers["chatgpt-account-id"]).toBe("acc_9");
	expect(seen.headers["OpenAI-Beta"]).toBe("responses=experimental");
	expect(seen.headers.authorization).toContain("Bearer ");
	expect(seen.body.stream).toBe(true);
	expect(seen.body.instructions).toBe("sys");
});

test("OAuthProxyModelClient throws on non-2xx (billing bypass still surfaces errors)", async () => {
	const fetchImpl = (async () => new Response("billing_not_active", { status: 429 })) as unknown as typeof fetch;
	const c = new OAuthProxyModelClient({ accessToken: "opaque", model: "m", fetchImpl });
	await expect(c.complete([{ role: "user", content: "x" }])).rejects.toThrow(/429/);
});

test("OAuthProxyModelClient omits chatgpt-account-id when the token has no claim", async () => {
	let headers: Record<string, string> = {};
	const fetchImpl = (async (_u: unknown, init?: unknown) => {
		headers = (init as RequestInit).headers as Record<string, string>;
		return new Response(sse([{ type: "response.output_text.delta", delta: "y" }]), { status: 200 });
	}) as unknown as typeof fetch;
	const c = new OAuthProxyModelClient({ accessToken: "opaque-token", model: "m", fetchImpl });
	await c.complete([{ role: "user", content: "x" }]);
	expect(headers["chatgpt-account-id"]).toBeUndefined();
});
