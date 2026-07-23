import { expect, test } from "bun:test";
import { visionAssert } from "../src/interpret/vision.ts";
import { FakeModelClient, type ModelMessage } from "../src/model/model-client.ts";

test("visionAssert sends the screenshot + expectation and returns true on YES", async () => {
	let seen: ModelMessage[] = [];
	const model = new FakeModelClient((msgs) => {
		seen = msgs;
		return "YES";
	});
	const ok = await visionAssert(model, "data:image/png;base64,ABC", "알림 버튼이 붉은색으로 표시된다");
	expect(ok).toBe(true);
	const user = seen.find((m) => m.role === "user");
	expect(Array.isArray(user?.content)).toBe(true);
	const parts = user?.content as Exclude<ModelMessage["content"], string>;
	expect(parts.some((p) => p.type === "image" && p.imageUrl.startsWith("data:image"))).toBe(true);
	expect(parts.some((p) => p.type === "text" && p.text.includes("붉은색"))).toBe(true);
});

test("visionAssert returns false on a NO reply", async () => {
	const model = new FakeModelClient(() => "NO 화면에 없음");
	expect(await visionAssert(model, "data:image/png;base64,ABC", "x")).toBe(false);
});

test("visionAssert accepts a Korean 예 as affirmative", async () => {
	const model = new FakeModelClient(() => "예");
	expect(await visionAssert(model, "data:image/png;base64,ABC", "x")).toBe(true);
});
