import { expect, test } from "bun:test";
import { deriveRestrictionAssertions } from "../src/interpret/author.ts";
import { isProse } from "../src/interpret/interpret.ts";
import {
	bumpRuleVersion,
	establishRuleFromHeaders,
	type InterpretationRule,
	parseRule,
	refineRule,
	ruleLint,
	serializeRule,
} from "../src/interpret/rule.ts";
import { FakeModelClient, type ModelMessage } from "../src/model/model-client.ts";

const HEADERS = ["Test ID", "Title", "Steps", "Expected Result", "Role", "Environment"];

test("establishRuleFromHeaders derives mapping + v1 + default intents/destructive", () => {
	const r = establishRuleFromHeaders(HEADERS);
	expect(r.ruleVersion).toBe(1);
	expect(r.mapping.id).toBe("Test ID");
	expect(r.mapping.step).toBe("Steps");
	expect(r.mapping.expected).toBe("Expected Result");
	expect(r.intents.click).toContain("click");
	expect(r.destructiveKeywords).toContain("delete");
});

test("serializeRule -> parseRule round-trips every field, including the optional ones", () => {
	// This test existed and passed while `routes` was being parsed away, because the rule it round-tripped
	// had no optional fields set at all. `parseRule` rebuilds field by field, so anything not listed there
	// is silently dropped — recon wrote six routes, the state file kept them, the next server start lost
	// them, and everything downstream behaved as if app analysis had never run. Populate everything.
	// The same trap twice: `phrases`/`charClasses` fall back to defaults when absent, so a rule carrying
	// *default* vocabulary round-trips even when the field is dropped. They must differ from the defaults
	// for this to detect anything.
	const full: InterpretationRule = {
		...establishRuleFromHeaders(HEADERS),
		appContext: "공문 발송 시스템 — 관리자 콘솔",
		codeContext: "React SPA, routes under /src/pages",
		routes: [
			{ label: "계정 관리", path: "/account" },
			{ label: "대시보드", path: "/dashboard" },
		],
		phrases: {
			prose: ["must", "필요하다"],
			navigation: ["jumps to"],
			restriction: ["blocked"],
			uiNoun: ["widget"],
			lengthUnit: ["signs"],
			exceed: ["beyond"],
			anyRow: ["whichever"],
			rowNoun: ["line"],
			toggleNoun: ["switch"],
			selected: ["ends up chosen"],
			reflected: ["is kept"],
			overlayCloser: ["dismiss this"],
		},
		charClasses: { hangul: ["hangeul"], upper: ["caps"], symbol: ["punct"], nonDigit: ["not numeric"] },
	};
	expect(parseRule(serializeRule(full))).toEqual(full);
});

test("parseRule keeps only routes that are really a label and an internal path", () => {
	// Off-disk input: a half-written or hand-edited state file must not produce a route that sends every
	// derived assertion and preparation somewhere absurd.
	const base = establishRuleFromHeaders(HEADERS);
	const parsed = parseRule(
		JSON.stringify({
			...base,
			routes: [
				{ label: "계정 관리", path: "/account" },
				{ label: "  ", path: "/blank" },
				{ label: "외부", path: "https://example.com" },
				{ label: "누락" },
				"not an object",
			],
		}),
	);
	expect(parsed.routes).toEqual([{ label: "계정 관리", path: "/account" }]);
	// Nothing usable → absent, not an empty array, so callers can treat it as "analysis never ran".
	expect(parseRule(JSON.stringify({ ...base, routes: [] })).routes).toBeUndefined();
	expect(parseRule(JSON.stringify({ ...base, routes: "nope" })).routes).toBeUndefined();
});

test("bumpRuleVersion increments only the version", () => {
	const r = establishRuleFromHeaders(HEADERS);
	const b = bumpRuleVersion(r);
	expect(b.ruleVersion).toBe(2);
	expect(b.mapping).toEqual(r.mapping);
});

test("refineRule applies a model change and bumps the version (cache invalidation), preserving unchanged parts", async () => {
	const r = establishRuleFromHeaders(HEADERS);
	const model = new FakeModelClient(() =>
		JSON.stringify({ destructiveKeywords: ["delete", "삭제"], message: "added 삭제" }),
	);
	const { rule, changed, message } = await refineRule(r, "삭제 means destructive", model);
	expect(changed).toBe(true);
	expect(rule.ruleVersion).toBe(2);
	expect(rule.destructiveKeywords).toContain("삭제");
	expect(rule.mapping).toEqual(r.mapping);
	expect(message).toBe("added 삭제");
});

test("refineRule with no effective change keeps the version stable", async () => {
	const r = establishRuleFromHeaders(HEADERS);
	const model = new FakeModelClient(() =>
		JSON.stringify({
			mapping: r.mapping,
			intents: r.intents,
			destructiveKeywords: r.destructiveKeywords,
			message: "no change",
		}),
	);
	const { rule, changed } = await refineRule(r, "no-op", model);
	expect(changed).toBe(false);
	expect(rule.ruleVersion).toBe(1);
});

test("refineRule threads prior conversation turns to the model", async () => {
	const r = establishRuleFromHeaders(HEADERS);
	let seen: ModelMessage[] = [];
	const model = new FakeModelClient((msgs) => {
		seen = msgs;
		return JSON.stringify({ intents: { ...r.intents, click: [...r.intents.click, "누르기"] }, message: "ok" });
	});
	const history: ModelMessage[] = [
		{ role: "user", content: "earlier ask" },
		{ role: "assistant", content: "earlier reply" },
	];
	const { rule, changed } = await refineRule(r, "also 누르기", model, history);
	expect(changed).toBe(true);
	expect(rule.intents.click).toContain("누르기");
	expect(seen.map((m) => m.content)).toContain("earlier reply");
});

test("ruleLint flags ambiguous phrases across intents and empty intents", () => {
	const r = establishRuleFromHeaders(HEADERS);
	r.intents.verify = [...r.intents.verify, "click"]; // now "click" is in both click + verify
	r.intents.wait = [];
	const warnings = ruleLint(r);
	expect(warnings.some((w) => w.includes('"click" is ambiguous'))).toBe(true);
	expect(warnings.some((w) => w.includes('intent "wait" has no trigger'))).toBe(true);
});

test("ruleLint is clean for the default rule", () => {
	expect(ruleLint(establishRuleFromHeaders(HEADERS))).toEqual([]);
});

test("an English sheet derives the same checks a Korean one does", () => {
	// The point of moving this vocabulary onto the rule: `(\d+)\s*자\s*(?:초과|이상)` and 특수문자 had no
	// English at all, so an English sheet derived nothing — and said nothing about deriving nothing.
	const rule = establishRuleFromHeaders(["ID", "Title", "Steps", "Expected Result"]);
	const typed = [{ kind: "fill", target: "Username", value: "abcdefghijklm" } as const];
	expect(
		deriveRestrictionAssertions(
			"1. Input must not accept it.",
			["1. Type over 12 characters into Username"],
			typed,
			rule,
		),
	).toEqual([{ kind: "fieldAtMost", field: "Username", max: 12 }]);
	expect(
		deriveRestrictionAssertions("1. Input is not allowed.", ["1. Type uppercase and special characters"], typed, rule),
	).toEqual([{ kind: "fieldExcludes", field: "Username", classes: ["upper", "symbol"] }]);
	// The Korean wording still works from the same defaults — this is an addition, not a swap.
	expect(
		deriveRestrictionAssertions("1. 입력 제한되어야 한다.", ["1. 아이디 입력란 내 12자 초과 입력"], typed, rule),
	).toEqual([{ kind: "fieldAtMost", field: "Username", max: 12 }]);
	expect(isProse("The badge should turn green", rule.phrases.prose)).toBe(true);
	expect(isProse("팝업이 표출되어야 한다", rule.phrases.prose)).toBe(true);
	expect(isProse("Signed in as viewer", rule.phrases.prose)).toBe(false);
});

test("a sheet can teach the judgement vocabulary, and a bad one cannot empty it", () => {
	const rule = establishRuleFromHeaders(["ID", "Title", "Steps", "Expected Result"]);
	// A sheet that words its limits differently: teach it, and the derivation follows.
	const taught: InterpretationRule = {
		...rule,
		phrases: { ...rule.phrases, restriction: ["blocked"], lengthUnit: ["signs"], exceed: ["beyond"] },
	};
	expect(
		deriveRestrictionAssertions(
			"Must be blocked.",
			["Type beyond 8 signs"],
			[{ kind: "fill", target: "Code", value: "x" }],
			taught,
		),
	).toEqual([{ kind: "fieldAtMost", field: "Code", max: 8 }]);
	// An empty or malformed list falls back rather than silently matching nothing ever again — an empty
	// vocabulary stops matching everything, and that never shows up in a verdict.
	const wiped = parseRule(JSON.stringify({ ...rule, phrases: { restriction: [], prose: "nope", lengthUnit: [""] } }));
	expect(wiped.phrases.restriction).toEqual(rule.phrases.restriction);
	expect(wiped.phrases.prose).toEqual(rule.phrases.prose);
	expect(wiped.phrases.lengthUnit).toEqual(rule.phrases.lengthUnit);
	// A phrase is matched literally: a vocabulary entry off disk must never act as a regex.
	const injected: InterpretationRule = { ...rule, phrases: { ...rule.phrases, restriction: [".*"] } };
	expect(
		deriveRestrictionAssertions(
			"anything",
			["Type over 5 characters"],
			[{ kind: "fill", target: "A", value: "x" }],
			injected,
		),
	).toEqual([]);
});
