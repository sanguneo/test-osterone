import { expect, test } from "bun:test";
import {
	bumpRuleVersion,
	establishRuleFromHeaders,
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

test("serializeRule -> parseRule round-trips", () => {
	const r = establishRuleFromHeaders(HEADERS);
	expect(parseRule(serializeRule(r))).toEqual(r);
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
