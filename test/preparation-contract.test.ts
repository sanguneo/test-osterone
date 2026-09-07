import { expect, test } from "bun:test";
import { sessionSatisfiesPrecondition } from "../src/app/studio/run-helpers.ts";
import { FakePage } from "../src/execute/page.ts";
import { runScenario } from "../src/execute/runner.ts";
import type { NormalizedTC } from "../src/intake/schema.ts";
import { MemoryAssertionCache } from "../src/interpret/assertion.ts";
import { preparationCacheKey } from "../src/interpret/author.ts";
import { establishRuleFromHeaders } from "../src/interpret/rule.ts";

test("only plain login prerequisites are satisfied by the matching authenticated account", () => {
	expect(sessionSatisfiesPrecondition("로그인된 상태", "admin", "admin")).toBe(true);
	expect(sessionSatisfiesPrecondition("The user is logged in.", "admin", "admin")).toBe(true);
	expect(sessionSatisfiesPrecondition("로그인된 상태", "admin", "viewer")).toBe(false);
	expect(sessionSatisfiesPrecondition("로그인된 상태", "admin", null)).toBe(false);
	expect(sessionSatisfiesPrecondition("로그인된 상태", undefined, null)).toBe(false);
	expect(sessionSatisfiesPrecondition("관리자로 로그인된 상태", "admin", "admin")).toBe(false);
	expect(sessionSatisfiesPrecondition("로그인된 상태이며 주문 1건 존재", "admin", "admin")).toBe(false);
});

test("preparation cache preserves significant whitespace and only normalizes line endings", () => {
	expect(preparationCacheKey('Enter "a  b"', "rule", 1)).not.toBe(preparationCacheKey('Enter "a b"', "rule", 1));
	expect(preparationCacheKey("First\r\nSecond", "rule", 1)).toBe(preparationCacheKey("First\nSecond", "rule", 1));
	expect(preparationCacheKey("Ready", "rule", 1)).toStartWith("prep2|");
});

test("independently satisfied preparation does not block the case, but unknown state does", async () => {
	const tc: NormalizedTC = {
		caseId: "TC-preparation",
		sourceId: "1",
		title: "View report",
		steps: ["Navigate to /report"],
		expected: "Report",
		precondition: "로그인된 상태",
		priority: null,
		role: null,
		env: null,
		category: null,
		contentHash: "preparation",
	};
	for (const satisfied of [true, false]) {
		let actions = 0;
		const result = await runScenario(tc, {
			page: new FakePage({ url: "/", text: "Landing", html: "<main>Landing</main>" }, () => {
				actions++;
				return { url: "/report", text: "Report", html: "<main>Report</main>" };
			}),
			rule: establishRuleFromHeaders([]),
			cache: new MemoryAssertionCache(),
			env: { browser: "fake", viewport: "test", baseUrl: "http://fixture" },
			preconditionSatisfied: satisfied,
		});
		expect(result.verdict).toBe(satisfied ? "pass" : "needs_review");
		expect(actions).toBe(satisfied ? 1 : 0);
	}
});
