import { expect, test } from "bun:test";

import { FakeModelClient } from "../src/model-client.ts";
import { bumpRuleVersion, establishRuleFromHeaders, parseRule, refineRule, serializeRule } from "../src/rule.ts";

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
