import { expect, test } from "bun:test";

import { MemoryBaselineStore, maskDynamic } from "../src/judge/baseline.ts";

test("maskDynamic redacts timestamps, uuids, and long digit runs", () => {
	const masked = maskDynamic("t 2026-07-17T14:00 id 550e8400-e29b-41d4-a716-446655440000 seq 1234567");
	expect(masked).not.toContain("2026-07-17");
	expect(masked).not.toContain("550e8400");
	expect(masked).not.toContain("1234567");
});

test("gate: no baseline -> proposes pending -> unapproved -> match after approve", () => {
	const s = new MemoryBaselineStore(() => 0);
	expect(s.gate("C1", 1, "staging", "Dashboard v1").status).toBe("no_baseline");
	expect(s.gate("C1", 1, "staging", "Dashboard v1").status).toBe("unapproved");
	s.approve("C1", 1, "staging");
	expect(s.gate("C1", 1, "staging", "Dashboard v1").status).toBe("match");
});

test("gate: dynamic-only change still matches (masking); a real change drifts", () => {
	const s = new MemoryBaselineStore(() => 0);
	s.gate("C1", 1, "staging", "Order 100001 at 2026-07-17T10:00");
	s.approve("C1", 1, "staging");
	expect(s.gate("C1", 1, "staging", "Order 999999 at 2026-07-18T11:22").status).toBe("match");
	expect(s.gate("C1", 1, "staging", "Order 100001 REMOVED").status).toBe("drift");
});

test("gate: a different ruleVersion is a distinct baseline needing its own approval", () => {
	const s = new MemoryBaselineStore(() => 0);
	s.gate("C1", 1, "staging", "X");
	s.approve("C1", 1, "staging");
	expect(s.gate("C1", 2, "staging", "X").status).toBe("no_baseline");
});
