import { expect, test } from "bun:test";

import type { PageSnapshot } from "../src/execute/page.ts";
import { AUTHOR_VERSION, assertionCacheKey, describeAssertion, evaluateAssertion } from "../src/interpret/assertion.ts";

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

const withFields = (fields: Record<string, string>): PageSnapshot => ({
	url: "/account",
	text: "신규 계정 생성",
	html: "<main>신규 계정 생성</main>",
	fields,
});

test("fieldAtMost catches the truncation a string check reads as a restriction", () => {
	// The reverted first attempt asserted the typed string was absent. An app that truncates 13 chars to
	// 12 no longer contains the 13-char string, so partial acceptance passed — and two cases whose
	// recorded defect is "the limit does not work" went green. Ask the field how long it is instead.
	const truncated = withFields({ 아이디: "abcdefghijkl" }); // 12 of the 13 typed
	const accepted = withFields({ 아이디: "abcdefghijklm" }); // all 13 — the limit did not work
	const a = { kind: "fieldAtMost", field: "아이디", max: 12 } as const;
	expect(evaluateAssertion(a, truncated).passed).toBe(true);
	const failed = evaluateAssertion(a, accepted);
	expect(failed.passed).toBe(false);
	expect(failed.detail).toContain("over the 12 limit");
	// Counted in characters, not UTF-16 units: a 3-char Hangul value is 3, not 3 surrogate pairs.
	expect(
		evaluateAssertion({ kind: "fieldAtMost", field: "아이디", max: 3 }, withFields({ 아이디: "가나다" })).passed,
	).toBe(true);
});

test("a field assertion fails when the field is nowhere to be found", () => {
	// The soundness property the string check lacked: if the typed value never landed anywhere, nothing
	// was restricted — so an unresolvable field is a failure to verify, never a pass.
	const elsewhere = withFields({ 비밀번호: "" });
	expect(evaluateAssertion({ kind: "fieldAtMost", field: "아이디", max: 12 }, elsewhere).passed).toBe(false);
	expect(evaluateAssertion({ kind: "fieldAtMost", field: "아이디", max: 12 }, elsewhere).detail).toContain(
		"not on screen",
	);
	// An empty field, on the other hand, is present and satisfies both kinds — the app cleared the input.
	expect(evaluateAssertion({ kind: "fieldAtMost", field: "비밀번호", max: 12 }, elsewhere).passed).toBe(true);
	// Spacing the app renders differently still resolves.
	expect(
		evaluateAssertion({ kind: "fieldAtMost", field: "기관유형", max: 5 }, withFields({ "기관 유형": "전체" })).passed,
	).toBe(true);
});

test("fieldExcludes names the character class the app let through", () => {
	// Sheets state these limits by kind, never by literal: "한글/영문 대문자/특수문자 입력 → 입력 제한".
	const a = { kind: "fieldExcludes", field: "아이디", classes: ["hangul", "upper", "symbol"] } as const;
	expect(evaluateAssertion(a, withFields({ 아이디: "abc123" })).passed).toBe(true);
	const hangul = evaluateAssertion(a, withFields({ 아이디: "한글abc" }));
	expect(hangul.passed).toBe(false);
	expect(hangul.detail).toContain("hangul");
	expect(evaluateAssertion(a, withFields({ 아이디: "ABC" })).detail).toContain("upper");
	expect(evaluateAssertion(a, withFields({ 아이디: "a!b" })).detail).toContain("symbol");
	// "숫자 외 텍스트 입력 → 입력 제한" means the field must end up holding digits only.
	const digits = { kind: "fieldExcludes", field: "연락처", classes: ["nonDigit"] } as const;
	expect(evaluateAssertion(digits, withFields({ 연락처: "01012345678" })).passed).toBe(true);
	expect(evaluateAssertion(digits, withFields({ 연락처: "010-1234" })).passed).toBe(false);
});

test("a field is resolved exactly, never by a noun two boxes happen to share", () => {
	// Stem matching was tried and removed: "아이디 입력란" resolved to a different box whose placeholder
	// shares the noun and which the case had never typed into, so its emptiness read as a working
	// restriction. Two cases whose recorded defect is "the limit does not work" passed that way.
	const two = withFields({ "아이디를 입력해 주세요.": "", 아이디: "abcdefghijklm" });
	// The box actually typed into answers, and it is over the limit.
	expect(evaluateAssertion({ kind: "fieldAtMost", field: "아이디", max: 12 }, two).passed).toBe(false);
	// The sheet's wording for a field the app labels differently is not guessed at — it fails closed.
	const r = evaluateAssertion({ kind: "fieldAtMost", field: "아이디 입력란", max: 12 }, two);
	expect(r.passed).toBe(false);
	expect(r.detail).toContain("not on screen");
	// Spacing the app renders differently still resolves, because that is the same label.
	expect(
		evaluateAssertion({ kind: "fieldAtMost", field: "기관유형", max: 5 }, withFields({ "기관 유형": "전체" })).passed,
	).toBe(true);
});

test("describeAssertion says what a field assertion checks, since it has no value", () => {
	expect(describeAssertion({ kind: "fieldAtMost", field: "아이디", max: 12 })).toBe("아이디 ≤ 12자");
	expect(describeAssertion({ kind: "fieldExcludes", field: "아이디", classes: ["hangul"] })).toBe(
		"아이디 제외: hangul",
	);
	expect(describeAssertion({ kind: "textIncludes", value: "저장 완료" })).toBe("저장 완료");
});

const withControls = (controls: Record<string, boolean>): PageSnapshot => ({
	url: "/account",
	text: "발송자 계정 수정 상태 활성 비활성",
	html: "<main>발송자 계정 수정</main>",
	controls,
});

test("controlSelected reads the toggle's state, which the page's text cannot express", () => {
	// The page reads the same either way — "활성"과 "비활성" are both on screen as labels whichever one is
	// on — so a text assertion cannot tell a selected radio from an unselected one.
	const off = withControls({ 활성: true, 비활성: false });
	const on = withControls({ 활성: false, 비활성: true });
	const a = { kind: "controlSelected", control: "비활성" } as const;
	expect(evaluateAssertion(a, off).passed).toBe(false);
	expect(evaluateAssertion(a, off).detail).toContain("is not selected");
	expect(evaluateAssertion(a, on).passed).toBe(true);
	expect(evaluateAssertion(a, on).detail).toContain("is selected");
	// Its counterpart moves the other way in the same breath — which is what makes the check discriminate.
	expect(evaluateAssertion({ kind: "controlSelected", control: "활성" }, on).passed).toBe(false);
});

test("controlSelected fails when the control is not on screen at all", () => {
	// Same soundness rule as the field checks: a click that never reached the control leaves a screen
	// with no such toggle on it, and reading that as a pass is how a missed click goes green.
	const none = withControls({ 활성: true });
	const missing = evaluateAssertion({ kind: "controlSelected", control: "비활성" }, none);
	expect(missing.passed).toBe(false);
	expect(missing.detail).toContain("not on screen");
	// A snapshot from a page with no toggles at all (or an adapter that cannot read them) fails too.
	expect(evaluateAssertion({ kind: "controlSelected", control: "활성" }, { url: "/", text: "", html: "" }).passed).toBe(
		false,
	);
	// Spacing the app renders differently still resolves — that is the same label, not a different one.
	expect(
		evaluateAssertion({ kind: "controlSelected", control: "사용안함" }, withControls({ "사용 안함": true })).passed,
	).toBe(true);
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
