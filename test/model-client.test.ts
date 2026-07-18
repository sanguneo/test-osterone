import { expect, test } from "bun:test";

import { ApiKeyModelClient } from "../src/model-client.ts";

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
