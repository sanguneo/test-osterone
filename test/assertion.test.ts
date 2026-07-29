import { expect, test } from "bun:test";

import type { PageSnapshot } from "../src/execute/page.ts";
import { AUTHOR_VERSION, assertionCacheKey, evaluateAssertion } from "../src/interpret/assertion.ts";

const snap = (text: string, url = "/"): PageSnapshot => ({ url, text, html: `<body>${text}</body>` });

test("textIncludes is strict by default — spacing must match", () => {
	const s = snap("전체 결재문서");
	expect(evaluateAssertion({ kind: "textIncludes", value: "전체결재문서" }, s).passed).toBe(false);
	expect(evaluateAssertion({ kind: "textIncludes", value: "전체 결재문서" }, s).passed).toBe(true);
});

test("lenient ignores whitespace and light punctuation", () => {
	const s = snap("결재 완료! (승인)");
	expect(evaluateAssertion({ kind: "textIncludes", value: "결재완료승인" }, s, { lenient: true }).passed).toBe(true);
	// same value stays a miss without the flag
	expect(evaluateAssertion({ kind: "textIncludes", value: "결재완료승인" }, s).passed).toBe(false);
});

test("textNotIncludes flips under lenient when the loose form matches", () => {
	const s = snap("Welcome, admin.");
	// strict: case/spacing differ → not present → passes
	expect(evaluateAssertion({ kind: "textNotIncludes", value: "welcome admin" }, s).passed).toBe(true);
	// lenient: punctuation/space stripped → present → "not includes" fails
	expect(evaluateAssertion({ kind: "textNotIncludes", value: "Welcome,admin" }, s, { lenient: true }).passed).toBe(
		false,
	);
});

test("urlIncludes is unaffected by lenient", () => {
	const s = snap("x", "/dashboard?tab=1");
	expect(evaluateAssertion({ kind: "urlIncludes", value: "/dashboard" }, s, { lenient: true }).passed).toBe(true);
	expect(evaluateAssertion({ kind: "urlIncludes", value: "/missing" }, s).passed).toBe(false);
});

test("a text assertion sees what was typed into a field, not just the page's text", () => {
	// The whole point: "12자 초과 입력 → 입력 제한되어야 한다" is only checkable if the engine can see
	// the field's live value. It is a DOM property, so it is in neither innerText nor the HTML.
	const restricted: PageSnapshot = {
		url: "/login",
		text: "로그인",
		html: "<body>로그인</body>",
		fields: { 아이디: "" },
	};
	const accepted: PageSnapshot = {
		url: "/login",
		text: "로그인",
		html: "<body>로그인</body>",
		fields: { 아이디: "한글ABC!@#" },
	};
	const a = { kind: "textNotIncludes", value: "한글ABC!@#" } as const;
	// App restricted the input → the value never landed → the case passes.
	expect(evaluateAssertion(a, restricted).passed).toBe(true);
	// App accepted it → the value is in the box → the case fails, which is the bug the sheet describes.
	const failed = evaluateAssertion(a, accepted);
	expect(failed.passed).toBe(false);
	expect(failed.detail).toContain("field value");
});

test("textIncludes matches a field value and says so, so a reviewer is not hunting the page", () => {
	const s: PageSnapshot = {
		url: "/find",
		text: "비밀번호 찾기",
		html: "<body>비밀번호 찾기</body>",
		fields: { 이메일: "qa@example.com" },
	};
	const r = evaluateAssertion({ kind: "textIncludes", value: "qa@example.com" }, s);
	expect(r.passed).toBe(true);
	expect(r.detail).toBe('field value has "qa@example.com"');
	// Page text still takes precedence in the wording when it is the one that matched.
	expect(evaluateAssertion({ kind: "textIncludes", value: "비밀번호 찾기" }, s).detail).toBe(
		'text has "비밀번호 찾기"',
	);
});

test("the cache key covers the authoring contract, not just its inputs", () => {
	// Improving authoring used to reach nothing: a sheet that had already run kept its plans forever,
	// because the key described the case and the rule but never the code that turned them into a plan.
	const key = assertionCacheKey("TC-1", "default", 3, "hash");
	expect(key).toContain(`a${AUTHOR_VERSION}`);
	// Same inputs, different authoring contract → a miss, which is the whole point.
	expect(key).not.toBe("TC-1|default|v3|hash");
	// The inputs still each move the key on their own.
	expect(assertionCacheKey("TC-2", "default", 3, "hash")).not.toBe(key);
	expect(assertionCacheKey("TC-1", "other", 3, "hash")).not.toBe(key);
	expect(assertionCacheKey("TC-1", "default", 4, "hash")).not.toBe(key);
	expect(assertionCacheKey("TC-1", "default", 3, "hash2")).not.toBe(key);
});

test("a snapshot with no fields behaves exactly as before", () => {
	const s = snap("Welcome, admin.");
	expect(evaluateAssertion({ kind: "textIncludes", value: "Welcome" }, s).passed).toBe(true);
	expect(evaluateAssertion({ kind: "textNotIncludes", value: "Welcome" }, s).passed).toBe(false);
	expect(evaluateAssertion({ kind: "textNotIncludes", value: "nope" }, s).passed).toBe(true);
});
