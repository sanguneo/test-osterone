import { expect, test } from "bun:test";
import type { NormalizedTC } from "../src/intake/schema.ts";
import { assertionCacheKey } from "../src/interpret/assertion.ts";
import {
	authorPlanAI,
	derivePreparationActions,
	deriveQuotedAssertions,
	deriveReflectionAssertions,
	deriveRestrictionAssertions,
	deriveRouteAssertion,
	deriveSelectionAssertions,
	getOrAuthorPlan,
	MemoryPlanCache,
	splitEnumeratedValue,
	withDerivedAssertions,
	withRowClicks,
} from "../src/interpret/author.ts";
import {
	authorAssertions,
	expectedRequirements,
	parseStep,
	requirementCoverage,
	stepTarget,
} from "../src/interpret/interpret.ts";
import { establishRuleFromHeaders } from "../src/interpret/rule.ts";
import { FakeModelClient } from "../src/model/model-client.ts";

const RULE = establishRuleFromHeaders(["분류", "소분류", "시험절차", "예상결과"]);

function tc(over: Partial<NormalizedTC>): NormalizedTC {
	return {
		caseId: "TC-x",
		sourceId: null,
		title: "",
		steps: [],
		expected: "",
		priority: null,
		role: null,
		env: null,
		category: null,
		contentHash: "h",
		...over,
	};
}

test("stepTarget reduces a Korean step to the label the DOM actually carries", () => {
	const click = RULE.intents.click;
	expect(stepTarget("1. 개인정보처리방침 선택", click)).toBe("개인정보처리방침");
	expect(stepTarget("2. 로그인 버튼을 클릭한다", click)).toBe("로그인");
	expect(stepTarget("3. 신규 계정 생성 버튼 선택", click)).toBe("신규 계정 생성");
	expect(stepTarget("- 아이디/비밀번호 찾기 버튼 선택", click)).toBe("아이디/비밀번호 찾기");
	expect(stepTarget("1. 검색 아이콘 터치", click)).toBe("검색");
	// English steps keep working
	expect(stepTarget('Click "Sign in"', click)).toBe("");
	expect(stepTarget("Click the Save button", click)).toBe("Save");
});

test("parseStep understands Korean action steps (the default vocabulary is bilingual)", () => {
	expect(parseStep("1. 개인정보처리방침 선택", RULE)).toEqual({ kind: "click", target: "개인정보처리방침" });
	expect(parseStep("2. 로그인 버튼을 클릭한다", RULE)).toEqual({ kind: "click", target: "로그인" });
	expect(parseStep('3. 아이디 입력란에 "superadmin" 입력', RULE)).toEqual({
		kind: "fill",
		target: "아이디",
		value: "superadmin",
	});
	expect(parseStep("4. 로그인 화면이 표출되는지 확인", RULE).kind).toBe("verify");
	// No concrete value to type → honestly uninterpretable rather than a guessed fill.
	expect(parseStep("5. 아이디 입력란 내 텍스트 입력", RULE).kind).toBe("unknown");
});

test("authorAssertions refuses to assert a written requirement it cannot check", () => {
	// Prose expectations ("…되어야 한다") are never DOM text; asserting them fabricates a fail.
	expect(authorAssertions(tc({ expected: "1. 개인정보처리방침 팝업 표출되어야 한다." }), RULE)).toEqual([]);
	expect(authorAssertions(tc({ expected: "The badge should turn green" }), RULE)).toEqual([]);
	// A literal expected value is still asserted.
	expect(authorAssertions(tc({ expected: "Signed in as viewer" }), RULE)).toEqual([
		{ kind: "textIncludes", value: "Signed in as viewer" },
	]);
	// …and an explicit quoted verify step is always authored, prose expectation or not.
	expect(
		authorAssertions(tc({ steps: ['화면에 "발송 완료"가 표출되는지 확인'], expected: "표출되어야 한다" }), RULE),
	).toEqual([{ kind: "textIncludes", value: "발송 완료" }]);
});

test("authorPlanAI drops a prose assertion the model returned despite being told not to", async () => {
	// Observed on a live run of the 공문발송 sheet: the model echoed the requirement sentence back as
	// an assertion value. With lenient matching on, that near-missed its way to `pass` on a case a
	// human had marked Fail — so the model path enforces the same prose rule the rule path does.
	const model = new FakeModelClient(() =>
		JSON.stringify({
			actions: [{ kind: "click", target: "개인정보처리방침" }],
			assertions: [
				{ kind: "textIncludes", value: "1. 팝업이 종료되어야 한다." },
				{ kind: "textIncludes", value: "The popup should close" },
				{ kind: "textIncludes", value: "개인정보 처리방침" },
			],
		}),
	);
	const plan = await authorPlanAI(tc({ title: "로그인", steps: ["1. 개인정보처리방침 선택"] }), model);
	// The action survives; only the unverifiable requirement sentences are dropped.
	expect(plan.actions).toEqual([{ kind: "click", target: "개인정보처리방침" }]);
	expect(plan.assertions).toEqual([{ kind: "textIncludes", value: "개인정보 처리방침" }]);
});

test("authorPlanAI leaves a case with no assertions rather than an unearned verdict", async () => {
	// Every assertion was prose → author none. runScenario turns zero assertions into needs_review,
	// which is the documented preference over a pass or fail the engine did not earn.
	const model = new FakeModelClient(() =>
		JSON.stringify({
			actions: [{ kind: "goto", path: "/login" }],
			assertions: [{ kind: "textIncludes", value: "로고가 표출되어야 한다" }],
		}),
	);
	const plan = await authorPlanAI(tc({ steps: ["1. 로그인 페이지 확인"] }), model);
	expect(plan.actions).toHaveLength(1);
	expect(plan.assertions).toEqual([]);
});

test("getOrAuthorPlan re-sanitizes a cached plan so a stale prose assertion cannot come back", async () => {
	// The plan cache is persisted per sheet. A plan authored before the prose rule existed kept its
	// requirement-sentence assertion across a restart and passed a case again — tightening authoring
	// fixed nothing for exactly the sheets that had already run.
	const rule = establishRuleFromHeaders(["분류", "소분류", "시험절차", "예상결과"]);
	const cache = new MemoryPlanCache();
	const c = tc({ caseId: "TC-cached", contentHash: "h-cached" });
	const key = assertionCacheKey(c.caseId, rule.ruleId, rule.ruleVersion, c.contentHash);
	cache.set(key, {
		actions: [{ kind: "click", target: "개인정보처리방침" }],
		assertions: [
			{ kind: "textIncludes", value: "1. 팝업이 종료되어야 한다." },
			{ kind: "textIncludes", value: "개인정보 처리방침" },
		],
	});
	// The model must not be consulted — this is still a cache hit, just a scrubbed one.
	const model = new FakeModelClient(() => {
		throw new Error("must not author on a cache hit");
	});
	const got = await getOrAuthorPlan(c, rule, cache, model);
	expect(got.cacheHit).toBe(true);
	expect(got.plan.actions).toEqual([{ kind: "click", target: "개인정보처리방침" }]);
	expect(got.plan.assertions).toEqual([{ kind: "textIncludes", value: "개인정보 처리방침" }]);
});

test("expectedRequirements splits numbered outcomes and keeps their detail lines attached", () => {
	const expected = [
		"1. 로고 표출되어야 하며 로고 하단에 타이틀 문구 표출되어야 한다.",
		"- 공문 발송 시스템",
		"2. 아이디 입력란, 비밀번호 입력란 표출되어야 한다.",
		"* 아이디 입력란 플레이스 홀더 : 아이디를 입력해주세요.",
		"  비밀번호 입력란 플레이스 홀더 : 비밀번호를 입력해주세요.",
		"3. 로그인 버튼 표출되어야 한다.",
	].join("\n");
	const reqs = expectedRequirements(expected);
	// Three requirements, not six: `-` / `*` / continuation lines describe the item above them.
	expect(reqs).toHaveLength(3);
	expect(reqs[0]).toContain("공문 발송 시스템");
	expect(reqs[1]).toContain("플레이스 홀더");
	expect(reqs[2]).toBe("3. 로그인 버튼 표출되어야 한다.");
	expect(expectedRequirements("1. 팝업이 종료되어야 한다.")).toHaveLength(1);
	expect(expectedRequirements("")).toEqual([]);
});

test("requirementCoverage names the outcomes no assertion refers to", () => {
	// The NO 137 shape: four written outcomes, two assertions, and the defect a human later filed
	// (the ordering) sits in the ones nothing checked.
	const expected = [
		"1. NO, 기관유형, 기관명, 아이디 항목이 제공되어야 한다.",
		"2. 생성된 계정 리스트 표출되어야 한다.",
		"* 최신 생성 계정 상단 위치 정렬",
		"3. 이메일은 마스킹 처리되어 표출되어야 한다.",
		"4. 연락처는 마스킹 처리되어 표출되어야 한다.",
	].join("\n");
	const cov = requirementCoverage(expected, [
		{ kind: "textIncludes", value: "기관유형" },
		{ kind: "textIncludes", value: "*****" },
	]);
	expect(cov).not.toBeNull();
	expect(cov?.total).toBe(4);
	expect(cov?.covered).toBe(1); // only requirement 1 is referred to
	expect(cov?.missing).toHaveLength(3);
	expect(cov?.missing[0]).toContain("계정 리스트");
});

test("requirementCoverage reports full coverage, and for one outcome asks only whether anything is about it", () => {
	const expected = "1. 팝업 표출되어야 한다.\n2. X 버튼 표출되어야 한다.";
	expect(
		requirementCoverage(expected, [
			{ kind: "textIncludes", value: "팝업" },
			{ kind: "textIncludes", value: "X 버튼" },
		]),
	).toEqual({ total: 2, covered: 2, missing: [] });
	// One requirement asks the narrower question: is *any* assertion about this outcome? Measured false
	// passes were "입력 제한되어야 한다" checked by the email field's hint, and "붉은색으로 표시" checked by
	// the hint's content — nothing attributable either time.
	expect(requirementCoverage("1. 팝업이 종료되어야 한다.", [{ kind: "textIncludes", value: "닫힘" }])).toEqual({
		total: 1,
		covered: 0,
		missing: ["1. 팝업이 종료되어야 한다."],
	});
	// An assertion quoting the requirement is attributable, so a single-outcome case can still pass.
	expect(
		requirementCoverage("1. 저장 완료 문구 표출되어야 한다.", [{ kind: "textIncludes", value: "저장 완료" }])?.covered,
	).toBe(1);
	// A derived url check is by construction about the expectation; requiring its path to appear in the
	// prose would reject every one of them.
	expect(
		requirementCoverage("1. 대시보드로 이동되어야 한다.", [{ kind: "urlIncludes", value: "/dashboard" }])?.covered,
	).toBe(0);
	// Whitespace differences must not manufacture a gap.
	expect(
		requirementCoverage("1. 전체 결재문서 표출되어야 한다.\n2. 목록 표출되어야 한다.", [
			{ kind: "textIncludes", value: "전체결재문서" },
			{ kind: "textIncludes", value: "목록" },
		])?.covered,
	).toBe(2);
});

test("an enumerated expectation becomes one assertion per item", () => {
	// Measured on the live app: the page showed 기관 유형 전체 공공기관 이지스 지자체 위탁관리 일반업체 —
	// all five labels present, the comma-joined string absent. As one assertion the case could only
	// ever miss; as five it actually discriminates.
	expect(splitEnumeratedValue("이지스, 지자체, 공공기관, 위탁관리, 일반업체")).toEqual([
		"이지스",
		"지자체",
		"공공기관",
		"위탁관리",
		"일반업체",
	]);
	expect(splitEnumeratedValue("전체, 발송 완료, 발송 대기, 발송 실패")).toHaveLength(4);
	expect(splitEnumeratedValue("NO, 기관유형, 기관명, 아이디, 이메일, 연락처, 상태")).toHaveLength(7);
});

test("splitEnumeratedValue leaves anything that is not a list of labels alone", () => {
	// Two parts is a phrase, not an enumeration — splitting would trade an adjacency check for two
	// loose word searches.
	expect(splitEnumeratedValue("Welcome, admin")).toEqual(["Welcome, admin"]);
	expect(splitEnumeratedValue("Welcome, admin. Dashboard loaded.")).toEqual(["Welcome, admin. Dashboard loaded."]);
	// A sentence-length part means this is prose with commas, not a list.
	const sentence = "기관을 선택하고, 최고 관리자로 접속할 수 있습니다, 라는 안내가 표출되어야 한다";
	expect(splitEnumeratedValue(sentence)).toEqual([sentence]);
	expect(splitEnumeratedValue("단일값")).toEqual(["단일값"]);
});

test("authorPlanAI splits an enumerated assertion and leaves textNotIncludes intact", async () => {
	const model = new FakeModelClient(() =>
		JSON.stringify({
			actions: [{ kind: "click", target: "기관 유형" }],
			assertions: [
				{ kind: "textIncludes", value: "이지스, 지자체, 공공기관, 위탁관리, 일반업체" },
				// A typed string that happens to contain commas must stay one value.
				{ kind: "textNotIncludes", value: "a,b,c" },
			],
		}),
	);
	const plan = await authorPlanAI(tc({ steps: ["1. 기관 유형 필터 선택"] }), model);
	expect(plan.assertions.filter((a) => a.kind === "textIncludes")).toHaveLength(5);
	expect(plan.assertions.filter((a) => a.kind === "textNotIncludes")).toEqual([
		{ kind: "textNotIncludes", value: "a,b,c" },
	]);
});
/** The route table recon produced for the live app. */
const ROUTES = [
	{ label: "공문 발송 현황", path: "/document" },
	{ label: "개인정보처리방침", path: "/privacy" },
	{ label: "계정 관리", path: "/account" },
	{ label: "기관 관리", path: "/agency" },
	{ label: "대시보드", path: "/dashboard" },
];

test("deriveRouteAssertion turns a navigation expectation into a url check", () => {
	// 56 of 652 cases claim the app must end up somewhere and only 4 ever got a url assertion. The
	// prompt was asked for this and ignored it (measured 0/10), so it is code and the table is truth.
	expect(deriveRouteAssertion("1. 대시보드로 이동되어야 한다.", ROUTES)).toEqual({
		kind: "urlIncludes",
		value: "/dashboard",
	});
	// Spacing in the sheet need not match the app's label.
	expect(deriveRouteAssertion("1. 관리자 계정관리 화면으로 이동되어야 한다.", ROUTES)).toEqual({
		kind: "urlIncludes",
		value: "/account",
	});
	expect(deriveRouteAssertion("1. 공문 발송 현황 목록으로 이동되어야 한다.", ROUTES)).toEqual({
		kind: "urlIncludes",
		value: "/document",
	});
});

test("deriveRouteAssertion stays silent unless the claim and the route are both unambiguous", () => {
	// No navigation claimed — a filter list appearing is not a route change.
	expect(deriveRouteAssertion("1. 필터 리스트 표출되어야 한다.", ROUTES)).toBeNull();
	// Pagination has no route of its own; inventing one would be a false fail on every run.
	expect(deriveRouteAssertion("1. 첫 페이지로 이동되어야 한다.", ROUTES)).toBeNull();
	// A destination the app never linked to.
	expect(deriveRouteAssertion("1. 비밀번호 변경 페이지로 이동되어야 한다.", ROUTES)).toBeNull();
	// No table (app analysis never ran) → nothing to derive from.
	expect(deriveRouteAssertion("1. 대시보드로 이동되어야 한다.", [])).toBeNull();
	// Two equally specific labels pointing at different paths: which one was meant is a guess.
	expect(
		deriveRouteAssertion("1. 목록으로 이동되어야 한다.", [
			{ label: "목록", path: "/a" },
			{ label: "목록", path: "/b" },
		]),
	).toBeNull();
	// A route whose path is "/" cannot discriminate — every url contains it. Recon really does produce
	// these: the live dashboard's 일간/월간 toggles are anchors with no href.
	expect(deriveRouteAssertion("1. 월간 화면으로 이동되어야 한다.", [{ label: "월간", path: "/" }])).toBeNull();
});

test("a plan gains the derived url assertion on read, and never overrides one the model wrote", async () => {
	// Derivation happens where the plan is *read*, not where it is authored, so a sheet that has already
	// run picks up a newly added check without being re-authored — and re-authoring is a dice roll that
	// moved this sheet's scorecard by ±2 cases three times in one session.
	const rule = { ...establishRuleFromHeaders(["분류", "소분류", "시험절차", "예상결과"]), routes: ROUTES };
	const nav = tc({ expected: "1. 대시보드로 이동되어야 한다." });
	const silent = new FakeModelClient(() => JSON.stringify({ actions: [], assertions: [] }));
	const authored = await authorPlanAI(nav, silent, {}, rule);
	// Authoring returns exactly what the model wrote.
	expect(authored.assertions).toEqual([]);
	expect(withDerivedAssertions(nav, rule, authored).assertions).toEqual([{ kind: "urlIncludes", value: "/dashboard" }]);

	const opinionated = { actions: [], assertions: [{ kind: "urlIncludes", value: "/dashboard?tab=1" } as const] };
	expect(withDerivedAssertions(nav, rule, opinionated).assertions).toEqual([
		{ kind: "urlIncludes", value: "/dashboard?tab=1" },
	]);
	// A plan cached before derivation moved already carries its derived checks; applying them again on
	// read must not double them.
	const alreadyDerived = { actions: [], assertions: [{ kind: "urlIncludes", value: "/dashboard" } as const] };
	expect(withDerivedAssertions(nav, rule, alreadyDerived).assertions).toEqual([
		{ kind: "urlIncludes", value: "/dashboard" },
	]);
});

test("a cached plan picks up a derived check it was never authored with", async () => {
	// The reason this moved: giving an already-run sheet a new judgement used to mean bumping
	// AUTHOR_VERSION, which re-rolls every plan through the model — so the change and the dice arrived
	// together and the measurement could not tell them apart.
	const rule = establishRuleFromHeaders(["분류", "소분류", "시험절차", "예상결과"]);
	const cache = new MemoryPlanCache();
	const radio = tc({
		steps: ["1. 상태 항목 내 비활성 라디오 버튼 선택"],
		expected: "1. 비활성 라디오 버튼 선택되어야 한다.",
	});
	const model = new FakeModelClient(() =>
		JSON.stringify({ actions: [{ kind: "click", target: "비활성" }], assertions: [] }),
	);
	const first = await getOrAuthorPlan(radio, rule, cache, model, {});
	expect(first.cacheHit).toBe(false);
	expect(first.plan.assertions).toEqual([{ kind: "controlSelected", control: "비활성" }]);
	// Second read never calls the model, and still carries the derived check.
	const dead = new FakeModelClient(() => {
		throw new Error("the model must not be called for a cached plan");
	});
	const second = await getOrAuthorPlan(radio, rule, cache, dead, {});
	expect(second.cacheHit).toBe(true);
	expect(second.plan.assertions).toEqual([{ kind: "controlSelected", control: "비활성" }]);
});
test("derivePreparationActions navigates by route instead of clicking the sheet's prose", () => {
	// Measured: 27 of 58 failed preparations were a click on the precondition's own words —
	// `click "전체 기관 관리"` is a heading, not a control — while 기관 관리 = /agency sat unused.
	expect(
		derivePreparationActions(
			"1. 전체 기관 관리 페이지 내 신규 기관 생성 버튼 선택된 상태",
			[
				{ kind: "click", target: "전체 기관 관리" },
				{ kind: "click", target: "신규 기관 생성" },
			],
			ROUTES,
		),
	).toEqual([
		{ kind: "goto", path: "/agency" },
		// The part the table cannot answer is still the model's job.
		{ kind: "click", target: "신규 기관 생성" },
	]);
	// A goto the model already authored for the same screen is not duplicated.
	expect(
		derivePreparationActions("1. 계정 관리 페이지 진입된 상태", [{ kind: "goto", path: "/account?page=0" }], ROUTES),
	).toEqual([{ kind: "goto", path: "/account" }]);
});

test("derivePreparationActions leaves a precondition it cannot place alone", () => {
	// "발송완료 상태 공문 상세페이지" names no route: a record has to be found, and inventing a goto
	// would send every such case to the wrong screen and then report it as reached.
	const actions = [{ kind: "click", target: "발송완료" } as const];
	expect(derivePreparationActions("1. 발송완료 상태 공문 상세페이지 진입된 상태", actions, ROUTES)).toEqual(actions);
	// No table at all (app analysis never ran) → nothing to derive, the model's plan is untouched.
	expect(derivePreparationActions("1. 계정 관리 페이지 진입된 상태", actions, [])).toEqual(actions);
});

test("withRowClicks turns 임의 X 선택 into a row click, because there is no label to click", () => {
	// 124 of 652 cases on the measured sheet say "pick any account / any item" — thirty times more than
	// every ordinal put together. The model dutifully authored `click "임의 계정"`, a target that has never
	// existed on any page, so the case failed before reaching what it was meant to verify.
	expect(
		withRowClicks([
			{ kind: "goto", path: "/account" },
			{ kind: "click", target: "임의 계정" },
		]),
	).toEqual([
		{ kind: "goto", path: "/account" },
		{ kind: "clickRow", nth: 1 },
	]);
	expect(withRowClicks([{ kind: "click", target: "첫 번째 항목" }])).toEqual([{ kind: "clickRow", nth: 1 }]);
	expect(withRowClicks([{ kind: "click", target: "any record" }])).toEqual([{ kind: "clickRow", nth: 1 }]);
});

test("withRowClicks needs both halves, so it cannot hijack an ordinary click", () => {
	// An "any" word alone is not a row: "임의의 문자를 입력" is typing, and clicking a row instead would
	// send the case somewhere it never asked to go.
	const keep = (target: string) =>
		expect(withRowClicks([{ kind: "click", target }])).toEqual([{ kind: "click", target }]);
	keep("임의 문자");
	keep("계정 관리");
	keep("저장");
	// Fills are never rewritten, whatever they say.
	expect(withRowClicks([{ kind: "fill", target: "임의 계정", value: "x" }])).toEqual([
		{ kind: "fill", target: "임의 계정", value: "x" },
	]);
});

test("deriveRestrictionAssertions reads the limit from the step and the field from the plan", () => {
	// The largest unverifiable class measured: 39 of 652 cases — 28 length limits, 11 character-class
	// limits. The expectation ("입력 제한되어야 한다") has no literal; the step has the limit and the plan's
	// own fill has the field.
	expect(
		deriveRestrictionAssertions(
			"1. 입력 제한되어야 한다.",
			["1. 아이디 입력란 내 12자 초과 입력"],
			[{ kind: "fill", target: "아이디", value: "abcdefghijklm" }],
		),
	).toEqual([{ kind: "fieldAtMost", field: "아이디", max: 12 }]);
	expect(
		deriveRestrictionAssertions(
			"1. 입력제한되어야 한다.",
			["1. 아이디 입력란 내 한글/영문대문자/특수문자 입력"],
			[{ kind: "fill", target: "아이디", value: "한글ABC!@#" }],
		),
	).toEqual([{ kind: "fieldExcludes", field: "아이디", classes: ["hangul", "upper", "symbol"] }]);
	// "숫자 외 텍스트 입력" means the field must end up holding digits only.
	expect(
		deriveRestrictionAssertions(
			"1. 입력 제한되어야 한다.",
			["1. 연락처 입력란 내 숫자 외 텍스트 입력"],
			[{ kind: "fill", target: "연락처", value: "abc" }],
		),
	).toEqual([{ kind: "fieldExcludes", field: "연락처", classes: ["nonDigit"] }]);
});

test("deriveRestrictionAssertions needs both halves and stays silent without them", () => {
	const typed = [{ kind: "fill", target: "아이디", value: "x" } as const];
	// Not a restriction expectation at all.
	expect(deriveRestrictionAssertions("1. 로그인되어야 한다.", ["1. 12자 초과 입력"], typed)).toEqual([]);
	// The step never says what the limit is, so there is nothing to check against.
	expect(deriveRestrictionAssertions("1. 입력 제한되어야 한다.", ["1. 아이디 입력란 내 텍스트 입력"], typed)).toEqual(
		[],
	);
	// Nothing was typed, so no field is implicated.
	expect(
		deriveRestrictionAssertions("1. 입력 제한되어야 한다.", ["1. 12자 초과 입력"], [{ kind: "click", target: "저장" }]),
	).toEqual([]);
});

test("deriveSelectionAssertions checks the control the plan clicked, not the prose around it", () => {
	// The two measured cases: the step selects a radio, the expectation says it must end up selected, and
	// nothing about that is text — the page reads identically either way.
	expect(
		deriveSelectionAssertions("1. 비활성 라디오 버튼 선택되어야 한다.", [{ kind: "click", target: "비활성" }]),
	).toEqual([{ kind: "controlSelected", control: "비활성" }]);
	expect(
		deriveSelectionAssertions("1. 활성 라디오 버튼 선택되어야 한다.", [{ kind: "click", target: "활성" }]),
	).toEqual([{ kind: "controlSelected", control: "활성" }]);
	// English sheets say it the other way round and must derive the same check.
	expect(
		deriveSelectionAssertions("1. The Inactive radio must be selected.", [{ kind: "click", target: "Inactive" }]),
	).toEqual([{ kind: "controlSelected", control: "Inactive" }]);
});

test("deriveSelectionAssertions stays silent unless the expectation is about a toggle it can name", () => {
	const click = [{ kind: "click", target: "활성" } as const];
	// "선택되어야 한다" without a radio/checkbox is the sheet's most common phrasing and is about text a
	// text assertion can already see — deriving a control check there would fail cases that are fine.
	expect(deriveSelectionAssertions("1. 계정 관리 메뉴가 선택되어야 한다.", click)).toEqual([]);
	// Names a radio but claims something else about it.
	expect(deriveSelectionAssertions("1. 라디오 버튼이 비활성화되어야 한다.", click)).toEqual([]);
	// Nothing was clicked, so no control is implicated: the prose alone never authors this.
	expect(
		deriveSelectionAssertions("1. 활성 라디오 버튼 선택되어야 한다.", [{ kind: "fill", target: "활성", value: "x" }]),
	).toEqual([]);
	// The plan clicked something the requirement does not mention.
	expect(
		deriveSelectionAssertions("1. 활성 라디오 버튼 선택되어야 한다.", [{ kind: "click", target: "저장" }]),
	).toEqual([]);
});

test("deriveSelectionAssertions will not let 활성 answer for 비활성", () => {
	// "활성" is a substring of "비활성". A plan that clicked the wrong one of the pair must not be handed a
	// check that reads as if it clicked the right one — that is a green light for the opposite outcome.
	expect(
		deriveSelectionAssertions("1. 비활성 라디오 버튼 선택되어야 한다.", [{ kind: "click", target: "활성" }]),
	).toEqual([]);
	// The reverse direction is a genuine mention, not a substring accident.
	expect(
		deriveSelectionAssertions("1. 활성/비활성 라디오 버튼이 선택되어야 한다.", [{ kind: "click", target: "활성" }]),
	).toEqual([{ kind: "controlSelected", control: "활성" }]);
});

test("deriveReflectionAssertions reads back the value the plan typed, not a guess at the prose", () => {
	// Measured on NO 223: "해당란에 반영되어야 한다" points at whatever box the step named, so there is no
	// literal in the expectation to quote — the case passed its check and was held anyway.
	expect(
		deriveReflectionAssertions("1. 해당란에 반영되어야 한다.", [
			{ kind: "fill", target: "발송 그룹", value: "테스트 발송 그룹" },
		]),
	).toEqual([{ kind: "fieldHolds", field: "발송 그룹", value: "테스트 발송 그룹" }]);
	expect(
		deriveReflectionAssertions("1. The value must be reflected in the field.", [
			{ kind: "fill", target: "Phone", value: "01012345678" },
		]),
	).toEqual([{ kind: "fieldHolds", field: "Phone", value: "01012345678" }]);
});

test("deriveReflectionAssertions needs both halves and stays silent without them", () => {
	const typed = [{ kind: "fill", target: "연락처", value: "01012345678" } as const];
	// The expectation is about something else entirely.
	expect(deriveReflectionAssertions("1. 입력 제한되어야 한다.", typed)).toEqual([]);
	expect(deriveReflectionAssertions("1. 목록이 표출되어야 한다.", typed)).toEqual([]);
	// Nothing was typed, so no field is implicated and the prose alone derives nothing.
	expect(deriveReflectionAssertions("1. 해당란에 반영되어야 한다.", [{ kind: "click", target: "저장" }])).toEqual([]);
	expect(
		deriveReflectionAssertions("1. 해당란에 반영되어야 한다.", [{ kind: "fill", target: "연락처", value: "" }]),
	).toEqual([]);
});

test("deriveQuotedAssertions reads the copy the requirement writes out under itself", () => {
	// 278 of this sheet's 652 expected results carry the exact words the screen must show, one line
	// under the sentence demanding them — and whether the model quotes that line is a coin flip.
	expect(
		deriveQuotedAssertions("1. 입력란 하단에 안내문구가 붉은색으로 출력되어야 한다.\n- 이메일 형식, 최대 255자 ", []),
	).toEqual([{ kind: "textIncludes", value: "이메일 형식, 최대 255자" }]);
	// Four names on one line are four things the screen must show; the comma-joined string is on no page.
	expect(
		deriveQuotedAssertions("1. 필터 리스트 표출되어야 한다.\n- 이지스엔터프라이즈, 한국환경공단, 소방청", []),
	).toEqual([
		{ kind: "textIncludes", value: "이지스엔터프라이즈" },
		{ kind: "textIncludes", value: "한국환경공단" },
		{ kind: "textIncludes", value: "소방청" },
	]);
	expect(deriveQuotedAssertions("1. The banner must show.\n- Accounts", [])).toEqual([
		{ kind: "textIncludes", value: "Accounts" },
	]);
});

test("deriveQuotedAssertions fills a gap and never competes with the model", () => {
	const quoted = "1. 문구 표출되어야 한다.\n- 검색된 목록이 없습니다.";
	// The model made a choice; this does not second-guess it. A second check could only lower the pass
	// ratio of a case the model already described.
	expect(deriveQuotedAssertions(quoted, [{ kind: "textIncludes", value: "검색 결과 없음" }])).toEqual([]);
	// A url or a field check is not a text choice, so the gap is still a gap.
	expect(deriveQuotedAssertions(quoted, [{ kind: "urlIncludes", value: "/agency" }])).toEqual([
		{ kind: "textIncludes", value: "검색된 목록이 없습니다." },
	]);
});

test("deriveQuotedAssertions refuses the lines that describe rather than quote", () => {
	// `*` introduces a note *about* the requirement on this sheet, and asserting it as page text fails a
	// case the app handled correctly — measured on NO 112's "* 기관 생성 시 작성한 유형값 반영".
	expect(deriveQuotedAssertions("1. 자동반영되어야 한다.\n* 기관 생성 시 작성한 유형값 반영", [])).toEqual([]);
	// "라벨 : 값" is an annotation, not the app's copy.
	expect(deriveQuotedAssertions("1. 타이틀 출력되어야 한다.\n- 기본값 : 전체", [])).toEqual([]);
	// Prose is another sentence of requirement, and asserting the requirement verbatim is the false pass
	// this engine has refused since 2026-07-27.
	expect(deriveQuotedAssertions("1. 팝업 표출되어야 한다.\n- 팝업이 종료되어야 한다.", [])).toEqual([]);
	// Nothing written under the requirement at all.
	expect(deriveQuotedAssertions("1. 수정 팝업 종료되어야 한다.", [])).toEqual([]);
});
