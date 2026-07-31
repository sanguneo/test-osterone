import { expect, test } from "bun:test";

import type { PageSnapshot } from "../src/execute/page.ts";
import {
	AUTHOR_VERSION,
	assertionCacheKey,
	authorableAssertions,
	dedupeAssertions,
	describeAssertion,
	evaluateAssertion,
	isIconographic,
	untypedFieldInTarget,
	withoutTrailingAnnotation,
} from "../src/interpret/assertion.ts";

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
	// The sheet's wording for a box the app labels differently is not guessed at — it fails closed, and
	// the judgement layer keeps that stricter than the click and fill rankings on purpose. Stripping the
	// trailing noun here took a measured 98-case sheet from 3 false passes to 5, and the two it added
	// were this exact shape: a same-named box the case had never typed into, empty, read as a working
	// restriction on cases whose recorded defect is that the limit does not work.
	const r = evaluateAssertion({ kind: "fieldAtMost", field: "아이디 입력란", max: 12 }, two);
	expect(r.passed).toBe(false);
	expect(r.detail).toContain("not on screen");
	const elsewhere = evaluateAssertion(
		{ kind: "fieldAtMost", field: "아이디 입력란", max: 12 },
		withFields({ "아이디를 입력해 주세요.": "" }),
	);
	expect(elsewhere.passed).toBe(false);
	expect(elsewhere.detail).toContain("not on screen");
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
	text: "계정 수정 상태 활성 비활성",
	html: "<main>계정 수정</main>",
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

test("fieldHolds asks whether the box kept what the case typed", () => {
	const kept = withFields({ 연락처: "01012345678" });
	const a = { kind: "fieldHolds", field: "연락처", value: "01012345678" } as const;
	expect(evaluateAssertion(a, kept).passed).toBe(true);
	// Separators the app adds itself are the app reflecting the input, not refusing it.
	expect(evaluateAssertion(a, withFields({ 연락처: "010-1234-5678" })).passed).toBe(true);
	// The defects this is written to catch: the box stayed empty, or kept only part of it.
	const empty = evaluateAssertion(a, withFields({ 연락처: "" }));
	expect(empty.passed).toBe(false);
	expect(empty.detail).toContain('not "01012345678"');
	expect(evaluateAssertion(a, withFields({ 연락처: "0101234567" })).passed).toBe(false);
	// And the same soundness rule as every other field check: no field, no verdict.
	expect(evaluateAssertion(a, withFields({ 이메일: "a@b.c" })).detail).toContain("not on screen");
});

test("dedupeAssertions keeps two field checks that differ only by field", () => {
	// `fieldHolds` carries a `value` like the string kinds do; keying on it alone would collapse two
	// checks about different boxes into one and silently drop half the case's verification.
	const a = { kind: "fieldHolds", field: "이메일", value: "x" } as const;
	const b = { kind: "fieldHolds", field: "연락처", value: "x" } as const;
	expect(dedupeAssertions([a, b, a])).toEqual([a, b]);
	expect(
		dedupeAssertions([
			{ kind: "textIncludes", value: "x" },
			{ kind: "textIncludes", value: "x" },
		]),
	).toEqual([{ kind: "textIncludes", value: "x" }]);
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

test("isIconographic: pure glyphs are iconography, anything with a word in it is copy", () => {
	// The pagination quotes that produced NO 161's false-fail — no letter, digit, or hangul anywhere.
	expect(isIconographic("<<")).toBe(true);
	expect(isIconographic(">")).toBe(true);
	expect(isIconographic("→")).toBe(true);
	expect(isIconographic("...")).toBe(true);
	// Copy: a page number, a Korean label, an English word — their absence is a real finding.
	expect(isIconographic("1")).toBe(false);
	expect(isIconographic("페이지번호")).toBe(false);
	expect(isIconographic("Save")).toBe(false);
	expect(isIconographic("x")).toBe(false);
	// Nothing at all is not iconography either — an empty check must not be softened by this rule.
	expect(isIconographic("")).toBe(false);
	expect(isIconographic("  ")).toBe(false);
});

test("authorableAssertions: one funnel drops what cannot be judged and reads past the sheet's annotations", () => {
	// A glyph names a control by the shape it is drawn as, and the app draws it as an icon printing no
	// text — so the check cannot pass on a working app. It is the mirror of the vacuous check this engine
	// already refuses, and it is dropped rather than softened later, so the clause is simply unchecked and
	// the coverage gate can say so. Measured (NO 161): human pass, engine fail on 4 glyph quotes.
	expect(
		authorableAssertions([
			{ kind: "textIncludes", value: "<<" },
			{ kind: "textIncludes", value: "∨" },
			{ kind: "textIncludes", value: "페이지번호" },
		]),
	).toEqual([{ kind: "textIncludes", value: "페이지번호" }]);
	// Only text checks: a url is never iconography, and a field check reads a value rather than the page.
	expect(authorableAssertions([{ kind: "urlIncludes", value: "/" }])).toEqual([{ kind: "urlIncludes", value: "/" }]);

	// Measured over 640 cases: every one of the 50 trailing parentheticals is an annotation, not copy.
	// The screen shows the part outside them, so quoting the whole thing failed on text the app prints.
	expect(
		authorableAssertions([
			{ kind: "textIncludes", value: "10~12자 조합 (X)" },
			{ kind: "textIncludes", value: "이미 생성된 아이디입니다.(붉은색)" },
		]),
	).toEqual([
		{ kind: "textIncludes", value: "10~12자 조합" },
		{ kind: "textIncludes", value: "이미 생성된 아이디입니다." },
	]);
	// Stripped before the dedupe, so two literals that differ only by their annotation collapse into one.
	expect(
		authorableAssertions([
			{ kind: "textIncludes", value: "10~12자 조합 (X)" },
			{ kind: "textIncludes", value: "10~12자 조합 (O)" },
		]),
	).toEqual([{ kind: "textIncludes", value: "10~12자 조합" }]);
});

test("withoutTrailingAnnotation can only relax a check, never tighten one", () => {
	expect(withoutTrailingAnnotation("아이디(관리자)")).toBe("아이디");
	expect(withoutTrailingAnnotation("10~12자 조합 (X)")).toBe("10~12자 조합");
	// A leading bracket is part of a name, not an annotation — annotations trail.
	expect(withoutTrailingAnnotation("(주)회사명")).toBe("(주)회사명");
	// Nothing usable left → keep what the sheet wrote rather than checking a fragment.
	expect(withoutTrailingAnnotation("(붉은색)")).toBe("(붉은색)");
	expect(withoutTrailingAnnotation("A(x)")).toBe("A(x)");
	// Untouched when there is no annotation at all.
	expect(withoutTrailingAnnotation("사용할 수 있는 기관명입니다.")).toBe("사용할 수 있는 기관명입니다.");
	// The relaxation is the safety argument: a shorter needle still matches every screen the longer one
	// matched, so this direction can never turn a passing check into a failing one.
	const screen = "고객센터 1566-5643 (내선 4번) / 평일 09:00 ~ 17:00";
	expect(screen.includes(withoutTrailingAnnotation("고객센터 1566-5643 (내선 4번)"))).toBe(true);
});

test("untypedFieldInTarget: a control named after an empty box names the setup that never happened", () => {
	// Measured (NO 206): the case pressed "기관명 중복확인" with 기관명 empty, because its precondition
	// was a data state ("중복된 이름이 없는 경우") the authored setup turned into "open the dialog".
	const empty = { 기관명: "", "기관 코드": "" };
	expect(untypedFieldInTarget("기관명 중복확인", empty)).toBe("기관명");
	// Longest field name wins, so the shorter one does not answer for the longer one's control.
	expect(untypedFieldInTarget("기관 코드 중복확인", { ...empty, 기관: "" })).toBe("기관 코드");
	// Spacing is the sheet's, not the app's.
	expect(untypedFieldInTarget("기관명중복확인", empty)).toBe("기관명");

	// A box that holds something has been set up — the click is answerable.
	expect(untypedFieldInTarget("기관명 중복확인", { 기관명: "가온" })).toBeNull();
	// So has one the run typed into and the app then cleared: that is a finding, not a missing setup.
	expect(untypedFieldInTarget("기관명 중복확인", empty, ["기관명"])).toBeNull();
	// Clicking the box itself is ordinary, not a control that operates it.
	expect(untypedFieldInTarget("기관명", empty)).toBeNull();
	// A control that names no field on screen is none of this rule's business.
	expect(untypedFieldInTarget("신규 기관 생성", { 아이디: "" })).toBeNull();
	expect(untypedFieldInTarget("저장", empty)).toBeNull();
	expect(untypedFieldInTarget("", empty)).toBeNull();
	expect(untypedFieldInTarget("기관명 중복확인", undefined)).toBeNull();
});
