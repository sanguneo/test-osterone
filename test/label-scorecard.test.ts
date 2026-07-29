import { expect, test } from "bun:test";

import { formatScorecard, parseHumanVerdict, scoreAgainstLabels } from "../src/report/label-scorecard.ts";

test("parseHumanVerdict reads the verdicts QA sheets actually contain", () => {
	expect(parseHumanVerdict("Pass")).toBe("pass");
	expect(parseHumanVerdict(" fail ")).toBe("fail");
	expect(parseHumanVerdict("통과")).toBe("pass");
	expect(parseHumanVerdict("실패")).toBe("fail");
	// NT (not tested) / NA (not applicable) / blank are not verdicts — scoring them either way would
	// invent an agreement or a disagreement nobody expressed.
	expect(parseHumanVerdict("NT")).toBe("unlabeled");
	expect(parseHumanVerdict("NA")).toBe("unlabeled");
	expect(parseHumanVerdict("")).toBe("unlabeled");
	expect(parseHumanVerdict(null)).toBe("unlabeled");
});

test("scoreAgainstLabels separates the two ways of being wrong", () => {
	const s = scoreAgainstLabels([
		{ caseId: "a", verdict: "pass", human: "Pass" },
		{ caseId: "b", verdict: "fail", human: "Fail" },
		// The fatal one: a human filed this as a defect and the engine called it green.
		{ caseId: "c", verdict: "pass", human: "Fail" },
		// Noisy but not fatal: blames the app for something a human accepted.
		{ caseId: "d", verdict: "fail", human: "Pass" },
	]);
	expect(s.agree).toBe(2);
	expect(s.falsePass).toBe(1);
	expect(s.falseFail).toBe(1);
	expect(s.cases.find((c) => c.caseId === "c")?.outcome).toBe("false-pass");
	expect(formatScorecard(s)).toContain("false-pass 1");
});

test("a held case is not counted as a miss, and its reason is grouped", () => {
	// Declining to judge is the engine working as designed, so it must not be scored as a wrong
	// answer — otherwise every honest hold would look like a regression.
	const s = scoreAgainstLabels([
		{ caseId: "a", verdict: "needs_review", human: "Fail", holdReason: "vision disagrees" },
		{ caseId: "b", verdict: "needs_review", human: "Pass", holdReason: "vision disagrees" },
		{ caseId: "c", verdict: "needs_review", human: "Fail", holdReason: "ai repair" },
		{ caseId: "d", verdict: "error", human: "Fail" },
	]);
	expect(s.held).toBe(4);
	expect(s.falsePass).toBe(0);
	expect(s.falseFail).toBe(0);
	expect(s.agree).toBe(0);
	// Most common first; ties break by reason name so the report is stable across runs.
	expect(s.holdsByReason).toEqual([
		{ reason: "vision disagrees", count: 2 },
		{ reason: "(unspecified)", count: 1 },
		{ reason: "ai repair", count: 1 },
	]);
});

test("unlabeled cases are reported separately, never folded into agreement", () => {
	const s = scoreAgainstLabels([
		{ caseId: "a", verdict: "pass", human: "NA" },
		{ caseId: "b", verdict: "fail", human: "" },
		{ caseId: "c", verdict: "pass", human: "Pass" },
	]);
	expect(s.unlabeled).toBe(2);
	expect(s.agree).toBe(1);
	expect(s.total).toBe(3);
});
