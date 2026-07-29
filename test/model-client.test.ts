import { expect, test } from "bun:test";

import { ApiKeyModelClient, DEFAULT_REQUEST_TIMEOUT_MS, requestTimeoutSignal } from "../src/model/model-client.ts";

test("every request carries an abort signal, so a model that stops answering is a failure not a wait", async () => {
	// Neither client bounded a request at all, leaving a hung call to undici's 300s+300s defaults. One
	// authoring call stalled a 98-case batch for nine minutes — 27% of that run's wall clock — and the
	// client watching the stream timed out.
	let seen: RequestInit | undefined;
	const fetchImpl = (async (_u: string, init: RequestInit) => {
		seen = init;
		return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
	}) as unknown as typeof fetch;
	const c = new ApiKeyModelClient({ apiKey: "k", model: "m", fetchImpl });
	await c.complete([{ role: "user", content: "x" }]);
	expect(seen?.signal).toBeInstanceOf(AbortSignal);
	expect(seen?.signal?.aborted).toBe(false);
});

test("the request ceiling is generous by default and overridable per call", () => {
	// A timeout that fires on healthy work would trade a visible stall for a silent rule-interpretation
	// fallback, which is worse: it does not show up in the verdicts at all.
	expect(DEFAULT_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
	expect(requestTimeoutSignal().aborted).toBe(false);
	// An explicit override wins, and a nonsensical one still yields a usable signal rather than throwing.
	expect(requestTimeoutSignal({ timeoutMs: 5_000 })).toBeInstanceOf(AbortSignal);
	expect(() => requestTimeoutSignal({ timeoutMs: 0 })).not.toThrow();
});

test("ApiKeyModelClient throws on non-2xx (never silently returns empty)", async () => {
	const fetchImpl = (async () => new Response("nope", { status: 429 })) as unknown as typeof fetch;
	const c = new ApiKeyModelClient({ apiKey: "k", model: "m", fetchImpl });
	await expect(c.complete([{ role: "user", content: "x" }])).rejects.toThrow(/429/);
});

test("ApiKeyModelClient returns empty string when the model yields no content", async () => {
	const fetchImpl = (async () =>
		new Response(JSON.stringify({ choices: [] }), { status: 200 })) as unknown as typeof fetch;
	const c = new ApiKeyModelClient({ apiKey: "k", model: "m", fetchImpl });
	expect(await c.complete([{ role: "user", content: "x" }])).toBe("");
});

test("ApiKeyModelClient normalizes a trailing slash in baseUrl", async () => {
	let url = "";
	const fetchImpl = (async (u: unknown) => {
		url = String(u);
		return new Response(JSON.stringify({ choices: [{ message: { content: "y" } }] }), { status: 200 });
	}) as unknown as typeof fetch;
	const c = new ApiKeyModelClient({ apiKey: "k", model: "m", baseUrl: "https://proxy.local/v1/", fetchImpl });
	await c.complete([{ role: "user", content: "x" }]);
	expect(url).toBe("https://proxy.local/v1/chat/completions");
});
