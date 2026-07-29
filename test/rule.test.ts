import { expect, test } from "bun:test";
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
	const full: InterpretationRule = {
		...establishRuleFromHeaders(HEADERS),
		appContext: "공문 발송 시스템 — 관리자 콘솔",
		codeContext: "React SPA, routes under /src/pages",
		routes: [
			{ label: "계정 관리", path: "/account" },
			{ label: "대시보드", path: "/dashboard" },
		],
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
