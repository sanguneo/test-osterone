import { expect, test } from "bun:test";

import type { PageSnapshot } from "../src/execute/page.ts";
import { evaluateAssertion } from "../src/interpret/assertion.ts";

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
