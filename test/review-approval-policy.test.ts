import { expect, test } from "bun:test";
import {
	baselineReviewEligible,
	type ReviewItem,
	reviewForClient,
	reviewMatchesExecution,
} from "../src/app/studio/store.ts";

test("only a review verified under the current approval policy is eligible", () => {
	expect(baselineReviewEligible({})).toBe(false);
	expect(baselineReviewEligible({ baselineEligible: true })).toBe(false);
	expect(baselineReviewEligible({ baselinePolicy: 2, baselineEligible: false })).toBe(false);
	expect(baselineReviewEligible({ baselinePolicy: 2, baselineEligible: true })).toBe(false);
	expect(
		baselineReviewEligible({ baselinePolicy: 2, baselineEligible: true, baselineText: "Checked", executionId: "run" }),
	).toBe(true);
});

test("review decisions cannot apply to a different or unidentified execution", () => {
	expect(reviewMatchesExecution({ executionId: "new" }, "old")).toBe(false);
	expect(reviewMatchesExecution({}, undefined)).toBe(false);
	expect(reviewMatchesExecution({ executionId: "new" }, "new")).toBe(true);
});

test("client reviews carry an execution binding without duplicating the private baseline text", () => {
	const item: ReviewItem = {
		caseId: "case",
		title: "Title",
		category: null,
		steps: ["Click"],
		expected: "Checked",
		verdict: "needs_review",
		reason: "AI repair",
		url: "/",
		text: "Preview",
		ruleVersion: 1,
		env: "test",
		sheetId: "sheet",
		baselinePolicy: 2,
		baselineEligible: true,
		executionId: "run",
		baselineText: "Full verified text",
	};
	const view = reviewForClient(item);
	expect(view.baselineEligible).toBe(true);
	expect(view.executionId).toBe("run");
	expect(view.baselineText).toBeUndefined();
	expect(item.baselineText).toBe("Full verified text");
});
