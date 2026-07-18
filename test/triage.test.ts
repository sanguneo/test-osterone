import { expect, test } from "bun:test";

import { ingestCsv } from "../src/ingest.ts";
import type { NormalizedTC } from "../src/schema.ts";
import { triageAll, triageDeterministic } from "../src/triage.ts";

function tc(over: Partial<NormalizedTC>): NormalizedTC {
	return {
		caseId: "TC-x",
		sourceId: null,
		title: "t",
		steps: ["Click Sign in"],
		expected: "ok",
		priority: null,
		role: null,
		env: null,
		contentHash: "x",
		...over,
	};
}

test("automatable when steps are browser-actionable and no human signals", () => {
	const d = triageDeterministic(
		tc({ steps: ["Navigate to /login", "Enter viewer", "Click Sign in"], expected: "Signed in" }),
	);
	expect(d.automatable).toBe(true);
	expect(d.signals).toEqual([]);
});

test("human-required when an OTP signal is present", () => {
	const d = triageDeterministic(tc({ steps: ["Enter the OTP from your phone"], expected: "logged in" }));
	expect(d.automatable).toBe(false);
	expect(d.signals).toContain("otp");
});

test("human-required when there are no steps", () => {
	const d = triageDeterministic(tc({ steps: [] }));
	expect(d.automatable).toBe(false);
	expect(d.reason).toBe("no executable steps");
});

test("triageAll splits automatable vs human-required preserving order", () => {
	const csv = [
		"Test ID,Title,Steps,Expected Result",
		'A,auto,"Navigate to /x\nClick Go",done',
		"B,manual,Enter the OTP sent via SMS,done",
	].join("\n");
	const { all } = ingestCsv(csv);
	const { automatable, humanRequired, decisions } = triageAll(all);
	expect(automatable).toHaveLength(1);
	expect(humanRequired).toHaveLength(1);
	expect(decisions).toHaveLength(2);
	expect(automatable[0]?.title).toBe("auto");
	expect(humanRequired[0]?.title).toBe("manual");
});
