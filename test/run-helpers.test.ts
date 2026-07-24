import { expect, test } from "bun:test";

import { isLoginOnlyCases, parseHealEvent } from "../src/app/studio/run-helpers.ts";

test("isLoginOnlyCases: true only when every case is a login/auth feature", () => {
	expect(isLoginOnlyCases([{ category: "로그인" }, { category: "login" }])).toBe(true);
	expect(isLoginOnlyCases([{ category: null, title: "sign in works" }])).toBe(true);
	expect(isLoginOnlyCases([{ category: null, title: "인증 토큰 갱신" }])).toBe(true);
	// a mixed sheet is NOT login-only → the run should auto-login first
	expect(isLoginOnlyCases([{ category: "로그인" }, { category: "전자결재" }])).toBe(false);
	expect(isLoginOnlyCases([])).toBe(false);
});

test("parseHealEvent: splits '<kind>: <target> — <error>' into kind + target", () => {
	expect(parseHealEvent("click: 로그인 — locator.click: Timeout 4000ms exceeded.")).toEqual({
		kind: "click",
		target: "로그인",
	});
	expect(parseHealEvent("fill: Username — boom")).toEqual({ kind: "fill", target: "Username" });
	expect(parseHealEvent("goto: /login")).toEqual({ kind: "goto", target: "/login" });
	expect(parseHealEvent("")).toEqual({ kind: "", target: "" });
});
