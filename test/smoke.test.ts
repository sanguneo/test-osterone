import { expect, test } from "bun:test";

import { VERSION } from "../src/cli.ts";
import { ApiKeyModelClient, FakeModelClient, type ModelMessage } from "../src/model-client.ts";

test("VERSION is the scaffold baseline", () => {
	expect(VERSION).toBe("0.1.0");
});

test("FakeModelClient returns the scripted reply deterministically", async () => {
	const c = new FakeModelClient((m) => `echo:${m[m.length - 1]?.content ?? ""}`);
	expect(await c.complete([{ role: "user", content: "hi" }])).toBe("echo:hi");
	expect(await c.complete([{ role: "user", content: "hi" }])).toBe("echo:hi");
});

test("ApiKeyModelClient posts chat-completions with Bearer auth and parses content", async () => {
	const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> } = {
		url: "",
		headers: {},
		body: {},
	};
	const fetchImpl = (async (url: unknown, init?: unknown) => {
		seen.url = String(url);
		seen.headers = (init as RequestInit).headers as Record<string, string>;
		seen.body = JSON.parse(String((init as RequestInit).body));
		return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;
	const c = new ApiKeyModelClient({ apiKey: "sk-x", model: "m", fetchImpl });
	const msgs: ModelMessage[] = [{ role: "user", content: "q" }];
	expect(await c.complete(msgs)).toBe("ok");
	expect(seen.url).toBe("https://api.openai.com/v1/chat/completions");
	expect(seen.headers.authorization).toBe("Bearer sk-x");
	expect(seen.body.model).toBe("m");
	expect((seen.body.messages as ModelMessage[])[0]?.content).toBe("q");
});
