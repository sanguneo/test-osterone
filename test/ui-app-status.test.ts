/**
 * What survives a failed status read (debt M3: "복구 가능한 실패의 명시적 상태화").
 *
 * The read used to be swallowed whole, so the top bar kept naming a connected model after the server
 * had stopped answering. Dropping the *whole* status instead would be the opposite mistake: the rules
 * view's step vocabulary and refine chat ride on this object, and losing them on a blip is worse than
 * a stale list. Both halves are the point, so both are asserted here.
 */
import { expect, test } from "bun:test";
import { withoutConnectionClaim } from "../src/app/studio/web/src/App.tsx";
import type { Status } from "../src/app/studio/web/src/types.ts";

const CONNECTED: Status = {
	connected: true,
	codexAvailable: true,
	auth: { mode: "codex (oauth)", model: "gpt-5.6-luna", reasoning: "high" },
	projectId: "p1",
	ruleVersion: 3,
	intents: { click: ["선택", "클릭"] },
	mapping: { "시험 항목": "title" },
	warnings: ["열 하나를 매핑하지 못했습니다"],
	chat: [{ role: "user", content: "제목 열은 '시험 항목'이야" }],
	appContext: "공문 발송 관리자",
	codeContext: "",
};

test("a failed status read drops the connection claim and keeps everything else", () => {
	const after = withoutConnectionClaim(CONNECTED);
	expect(after?.connected).toBe(false);
	// The vocabulary the rules view teaches, and the conversation that taught it, must survive.
	expect(after?.intents).toEqual(CONNECTED.intents);
	expect(after?.mapping).toEqual(CONNECTED.mapping);
	expect(after?.chat).toEqual(CONNECTED.chat);
	expect(after?.ruleVersion).toBe(3);
	expect(after?.appContext).toBe("공문 발송 관리자");
	// And the original is left alone — this runs inside a state updater.
	expect(CONNECTED.connected).toBe(true);
});

test("nothing to drop is a no-op, not a rewrite", () => {
	// No status yet (first load failed): there is no claim on screen to withdraw.
	expect(withoutConnectionClaim(null)).toBeNull();
	// Already disconnected: return the same object so React skips the re-render.
	const offline: Status = { ...CONNECTED, connected: false };
	expect(withoutConnectionClaim(offline)).toBe(offline);
});
