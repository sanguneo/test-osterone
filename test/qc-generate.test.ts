import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestCsv } from "../src/intake/ingest.ts";
import { loadSheet } from "../src/intake/load-sheet.ts";
import { type GeneratedCase, generateQc, toQcCsv, toQcWorkbook } from "../src/interpret/qc-generate.ts";
import { FakeModelClient, type ModelMessage } from "../src/model/model-client.ts";

const SPEC = [
	"# 로그인 기획서",
	"- FR-1 올바른 계정으로 로그인하면 `Welcome, admin. Dashboard loaded.` 를 표시한다.",
	"- FR-2 비밀번호가 틀리면 `Invalid credentials. Please try again.` 를 표시한다.",
].join("\n");

const OK1 = {
	id: "TC-001",
	category: "로그인",
	title: "올바른 계정으로 로그인",
	precondition: "",
	steps: [
		"open /",
		'enter "admin" into "Username"',
		'enter "secret" into "Password"',
		'click "Log in"',
		'verify page shows "Welcome, admin. Dashboard loaded."',
	],
	expected: "Welcome, admin. Dashboard loaded.",
	priority: "상",
	sourceRef: "FR-1",
};
const OK2 = {
	...OK1,
	id: "TC-002",
	title: "틀린 비밀번호",
	steps: [
		"open /",
		'enter "admin" into "Username"',
		'enter "wrong" into "Password"',
		'click "Log in"',
		'verify page shows "Invalid credentials. Please try again."',
	],
	expected: "Invalid credentials. Please try again.",
	sourceRef: "FR-2",
};

/** Replies in order; records every conversation it was given. */
function scripted(replies: string[]): { model: FakeModelClient; calls: ModelMessage[][] } {
	const calls: ModelMessage[][] = [];
	const model = new FakeModelClient((messages) => {
		calls.push(messages);
		const reply = replies[calls.length - 1];
		if (reply === undefined) throw new Error(`unexpected model call #${calls.length}`);
		return reply;
	});
	return { model, calls };
}

describe("generateQc", () => {
	test("happy path: canonical cases pass through, coverage per requirement, one call", async () => {
		const { model, calls } = scripted([
			`Here you go:\n${JSON.stringify({ cases: [OK1, OK2, { ...OK2, id: "TC-003" }] })}`,
		]);
		const result = await generateQc({ spec: SPEC, specName: "spec.md", model });
		expect(calls).toHaveLength(1);
		expect(result.cases.map((c) => c.id)).toEqual(["TC-001", "TC-002"]);
		expect(result.cases.every((c) => c.note === undefined)).toBe(true);
		expect(result.coverage).toEqual([
			{ requirement: "FR-1", cases: ["TC-001"] },
			{ requirement: "FR-2", cases: ["TC-002"] },
		]);
		expect(result.warnings).toEqual(["TC-003 removed: same content as TC-002"]);
	});

	test("unparseable step: one re-ask listing it, still-broken case kept and flagged", async () => {
		const bad = {
			...OK2,
			steps: ["open /", "로그인 버튼을 누른다", 'verify page shows "Invalid credentials. Please try again."'],
		};
		const stillBad = { ...bad, steps: ["open /", "press the login button", ...bad.steps.slice(2)] };
		const { model, calls } = scripted([
			JSON.stringify({ cases: [OK1, bad] }),
			JSON.stringify({ cases: [stillBad] }),
			"never asked a third time",
		]);
		const result = await generateQc({ spec: SPEC, specName: "spec.md", model });
		expect(calls).toHaveLength(2);
		const reask = calls[1]?.at(-1)?.content;
		expect(String(reask)).toContain("TC-002 step 2 `로그인 버튼을 누른다`");
		expect(String(reask)).not.toContain("TC-001");
		expect(result.cases).toHaveLength(2);
		const flagged = result.cases.find((c) => c.id === "TC-002");
		expect(flagged?.steps[1]).toBe("press the login button");
		expect(flagged?.note).toContain("step 2");
		expect(result.warnings.some((w) => w.startsWith("TC-002 not automatable"))).toBe(true);
		expect(result.cases.find((c) => c.id === "TC-001")?.note).toBeUndefined();
	});

	test("re-ask that fixes the step clears the flag", async () => {
		const bad = { ...OK2, steps: ["1. open /", "click Log in", ...OK2.steps.slice(4)] };
		const { model } = scripted([JSON.stringify({ cases: [OK1, bad] }), JSON.stringify({ cases: [OK2] })]);
		const result = await generateQc({ spec: SPEC, specName: "spec.md", model });
		expect(result.cases.find((c) => c.id === "TC-002")?.steps).toEqual(OK2.steps);
		expect(result.warnings).toEqual([]);
	});

	test("a canonical-looking step the engine reads differently is flagged", async () => {
		// "select" is a click keyword, so the engine would click instead of verifying.
		const tricky = { ...OK2, steps: ["open /", 'verify page shows "Please select a role"'] };
		const { model } = scripted([JSON.stringify({ cases: [tricky] }), JSON.stringify({ cases: [tricky] })]);
		const result = await generateQc({ spec: SPEC, specName: "spec.md", model });
		expect(result.cases[0]?.note).toContain('reads it as "click"');
		expect(result.warnings).toContain("FR-1 has no case");
	});

	test("malformed JSON is a clear error", async () => {
		const { model } = scripted(["Sure! Cases: [oops"]);
		await expect(generateQc({ spec: SPEC, specName: "spec.md", model })).rejects.toThrow(/malformed JSON.*Sure! Cases/);
	});
});

describe("written QC round trip", () => {
	const cases: GeneratedCase[] = [
		OK1,
		{ ...OK2, precondition: "관리자 계정이 존재하는 상태" },
		{ ...OK2, id: "TC-003", title: "깨진 단계", steps: ["open /", "로그인한다"], note: "자동화 불가 — step 2" },
	];

	/** Workbook intake prefixes the tab name to the category (merge.ts); a CSV has no tab. */
	function expectSame(loaded: ReturnType<typeof ingestCsv>, tab?: string): void {
		expect(loaded.unique).toHaveLength(cases.length);
		loaded.unique.forEach((tc, i) => {
			const c = cases[i] as GeneratedCase;
			expect(tc.sourceId).toBe(c.id);
			expect(tc.category).toBe(tab ? `${tab} / ${c.category}` : c.category);
			expect(tc.title).toBe(c.title);
			expect(tc.precondition ?? "").toBe(c.precondition);
			expect(tc.steps).toEqual(c.steps);
			expect(tc.expected).toBe(c.expected);
			expect(tc.priority).toBe(c.priority);
			expect(tc.note).toBe(c.note);
		});
	}

	test("xlsx: cover tab is skipped, QC tab yields the same cases", async () => {
		const dir = mkdtempSync(join(tmpdir(), "qcgen-"));
		try {
			const file = join(dir, "qc.xlsx");
			writeFileSync(file, toQcWorkbook(cases, { specName: "spec.md", date: "2026-10-06", modelLabel: "fake" }));
			const sheet = await loadSheet(file);
			expect(sheet.tabs.map((t) => [t.name, t.selected])).toEqual([
				["표지", false],
				["QC", true],
			]);
			expectSame(ingestCsv(sheet.csv), "QC");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("csv yields the same cases", async () => {
		const dir = mkdtempSync(join(tmpdir(), "qcgen-"));
		try {
			const file = join(dir, "qc.csv");
			writeFileSync(file, toQcCsv(cases), "utf8");
			expectSame(ingestCsv((await loadSheet(file)).csv));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
