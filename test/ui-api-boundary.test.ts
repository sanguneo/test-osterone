/**
 * The Studio client's HTTP boundary (debt M3: "API 경계에서 JSON을 제네릭/이벤트 타입으로 단언").
 *
 * Two live defects lived here, both invisible because nothing exercised the boundary:
 *
 *  - `runStream` never checked `res.ok`. The server refuses a second concurrent run with 409 and
 *    `{"error":"이미 실행 중인 런이 있습니다. 먼저 중지하세요."}` — a body, so the reader read it, and
 *    `JSON.parse(line) as RunEvent` produced an "event" with no `type`. The panel dispatches on `type`
 *    with no else, so it was dropped, the stream ended, and the run finished with *nothing on screen*.
 *  - `j` swallowed a JSON parse failure to `null` and returned it as `T`, so a caller failed several
 *    frames later on a field of the thing it believed it had.
 */
import { afterEach, expect, test } from "bun:test";
import { api, responseFailure } from "../src/app/studio/web/src/api.ts";
import type { RunEvent, RunInput } from "../src/app/studio/web/src/types.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Answer every request with one canned response. */
function serve(body: string, init: ResponseInit) {
	globalThis.fetch = Object.assign(async () => new Response(body, init), { preconnect: () => {} }) as typeof fetch;
}

const RUN: RunInput = { projectId: "p1", sheetId: "s1", sample: false };

test("responseFailure prefers the server's sentence, and is never empty", async () => {
	const refused = new Response(JSON.stringify({ error: "이미 실행 중인 런이 있습니다. 먼저 중지하세요." }), {
		status: 409,
		statusText: "Conflict",
	});
	expect((await responseFailure(refused)).message).toBe("이미 실행 중인 런이 있습니다. 먼저 중지하세요.");

	// Not JSON, or JSON without `error`: fall back rather than show a blank banner.
	expect(
		(await responseFailure(new Response("<h1>502</h1>", { status: 502, statusText: "Bad Gateway" }))).message,
	).toBe("Bad Gateway");
	// No reason phrase at all — HTTP/2 has none, and an empty message reads as "no error".
	expect((await responseFailure(new Response("", { status: 500, statusText: "" }))).message).toBe("HTTP 500");
});

test("a refused run rejects with the server's reason instead of being read as a stream", async () => {
	serve(JSON.stringify({ error: "이미 실행 중인 런이 있습니다. 먼저 중지하세요." }), {
		status: 409,
		headers: { "content-type": "application/json" },
	});
	const seen: RunEvent[] = [];
	await expect(api.runStream(RUN, (ev) => seen.push(ev))).rejects.toThrow(
		"이미 실행 중인 런이 있습니다. 먼저 중지하세요.",
	);
	// The refusal must not reach the panel disguised as an event — that is how it used to vanish.
	expect(seen).toEqual([]);
});

test("a refused run-all rejects the same way", async () => {
	serve(JSON.stringify({ error: "이미 실행 중인 런이 있습니다. 먼저 중지하세요." }), { status: 409 });
	await expect(api.runAllStream(RUN, () => {})).rejects.toThrow("이미 실행 중인 런이 있습니다");
});

test("a stream that really is a stream still yields its events", async () => {
	const lines = [
		JSON.stringify({ type: "start", total: 1 }),
		JSON.stringify({ type: "notice", message: "레인 준비" }),
		"",
	].join("\n");
	serve(lines, { status: 200, headers: { "content-type": "application/x-ndjson" } });
	const seen: RunEvent[] = [];
	await api.runStream(RUN, (ev) => seen.push(ev));
	expect(seen.map((e) => e.type)).toEqual(["start", "notice"]);
});

test("a 2xx that is not JSON fails at the boundary, not in the caller", async () => {
	serve("<!doctype html><html>Studio</html>", { status: 200, headers: { "content-type": "text/html" } });
	// It used to resolve with `null` typed as `Project[]`, and the first `.map` blamed the wrong place.
	await expect(api.projects()).rejects.toThrow("response was not JSON (200)");
});

test("a normal JSON response is untouched", async () => {
	serve(JSON.stringify([{ id: "p1", name: "프로젝트" }]), { status: 200 });
	expect(await api.projects()).toEqual([{ id: "p1", name: "프로젝트" }] as never);
});
