/**
 * Fixture provenance (Tencent/BrowserSkill, fetched 2026-10-06):
 * - Envelope + state bodies: crates/bsk-protocol/schema/trace_v3.json (TraceV3/TraceStateV3) and
 *   crates/bsk-cli/src/cli/record/export.rs (`--json` envelope `{output, states_dir, trace, trace_json, ...}`);
 *   bsk-trace-envelope.json is verbatim (paths shortened) what `bsk record stop --json` 0.3.2 printed for the
 *   fixture login page in this repo.
 * - Step shapes: crates/bsk-protocol/schema/trace_step_v3.json and apps/extension/src/lib/recording/
 *   trace-reducer-v3.ts (`fill` always has `commit`; redaction -> `value: "***", redacted: true`;
 *   unmatched targets -> `{role, name, unmatched: true}`), as exercised in
 *   apps/extension/src/lib/__tests__/trace-reducer-v3.test.ts. Password fills: apps/extension/src/content/
 *   record-capture.ts (`type === "password"` -> "***" + redacted).
 * - Bundle on disk (`states[].page`, `states/sN.txt`): export.rs `write_trace_bundle` / `BundleState`.
 */
import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as XLSX from "xlsx";
import { appendCaseToSheet, loadTraceBundle, traceToCase } from "../src/intake/bsk-trace.ts";
import { ingestCsv } from "../src/intake/ingest.ts";
import { loadSheet } from "../src/intake/load-sheet.ts";
import { parseStep } from "../src/interpret/interpret.ts";
import { establishRuleFromHeaders } from "../src/interpret/rule.ts";

const RULE = establishRuleFromHeaders(["Test ID", "Title", "Steps", "Expected"]);
const fixture = (name: string): unknown =>
	JSON.parse(readFileSync(join(import.meta.dir, "fixtures", `bsk-trace-${name}.json`), "utf8"));

function expectAllKnown(steps: string[]): void {
	for (const step of steps) expect({ step, kind: parseStep(step, RULE).kind }).not.toMatchObject({ kind: "unknown" });
}

async function withDir(run: (dir: string) => unknown): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "bsk-trace-"));
	try {
		await run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("a recorded login becomes the canonical case, with the password replaced and the witnessed outcome asserted", () => {
	const row = traceToCase(fixture("login"), { baseUrl: "http://localhost:65331", id: "REC-1" });
	expect(row.steps).toEqual([
		"open /",
		'enter "admin" into "Username"',
		'enter "<secret>" into "Password"',
		'click "Log in"',
		'verify page shows "Welcome, admin. Dashboard loaded."',
	]);
	expect(row.expected).toBe("Welcome, admin. Dashboard loaded.");
	expect(row).toMatchObject({ id: "REC-1", title: "login as admin" });
	expect(row.warnings).toEqual([expect.stringContaining("<secret>")]);
	expect(JSON.stringify(row)).not.toContain("***");
	expectAllKnown(row.steps);
	expect(row.steps.map((s) => parseStep(s, RULE).kind)).toEqual(["goto", "fill", "fill", "click", "verify"]);
});

test("every event the grammar cannot replay is a warning, never silently dropped", () => {
	const row = traceToCase(fixture("mixed"), { baseUrl: "https://shop.example.com/app/", title: "Settings" });
	expect(row.steps).toEqual([
		"open /",
		"open /settings",
		'enter "shoes" into "Search"',
		'click "Enter details"',
		"open https://elsewhere.example.org/help",
	]);
	expectAllKnown(row.steps);
	// Each recorded step id that produced no faithful grammar step is named in a warning.
	for (const id of [2, 3, 5, 6, 7, 8, 9, 10, 11, 12]) {
		expect(row.warnings.some((w) => w.startsWith(`step ${id} (`))).toBe(true);
	}
	expect(row.warnings.find((w) => w.startsWith("step 7 "))).toContain("reads back as fill");
	expect(row.warnings.find((w) => w.startsWith("step 9 "))).toContain("not replayed");
	expect(row.warnings.find((w) => w.startsWith("step 11 "))).toContain("unknown recorded event");
	// Nothing new appeared after the last action, so no expectation is invented.
	expect(row.expected).toBe("");
	expect(row.warnings.at(-1)).toMatch(/^outcome: .*no new text/);
});

test("the `bsk record --json` envelope is unwrapped; a recording with no actions asserts nothing", () => {
	const row = traceToCase(fixture("envelope"));
	expect(row.steps).toEqual(["open /"]);
	expectAllKnown(row.steps);
	expect(row.expected).toBe("");
	expect(row.title).toBe("login as admin");
	expect(row.id).toBe("REC-20261006105818");
	expect(row.warnings).toEqual([expect.stringMatching(/^outcome: /)]);
});

test("a non-v3 trace is refused instead of guessed at", () => {
	expect(() => traceToCase({ version: 2, steps: [], states: [] })).toThrow(/unsupported trace version 2/);
	expect(() => traceToCase("nope")).toThrow(/JSON object/);
});

test("an on-disk bundle reads state bodies from states/sN.txt", async () => {
	await withDir((dir) => {
		const wire = fixture("login") as { states: { id: string; body: string; [k: string]: unknown }[] };
		const disk = { ...wire, states: wire.states.map(({ body: _body, ...s }) => ({ ...s, page: `${s.id}.txt` })) };
		mkdirSync(join(dir, "states"));
		for (const s of wire.states) writeFileSync(join(dir, "states", `${s.id}.txt`), s.body);
		writeFileSync(join(dir, "trace.json"), JSON.stringify(disk));
		const { trace, stateBodies } = loadTraceBundle(dir);
		const row = traceToCase(trace, { stateBodies });
		expect(row.expected).toBe("Welcome, admin. Dashboard loaded.");
		expectAllKnown(row.steps);
	});
});

const ROW = {
	id: "REC-1",
	title: "Valid login",
	steps: ["open /", 'enter "admin" into "Username"', 'click "Log in"'],
	expected: "Welcome",
};

test("a CSV is created with canonical headers, appended to, and refuses a duplicate id", async () => {
	await withDir((dir) => {
		const file = join(dir, "qc.csv");
		appendCaseToSheet(file, ROW);
		appendCaseToSheet(file, { ...ROW, id: "REC-2", title: "Again" });
		expect(readFileSync(file, "utf8").split("\n")[0]).toBe("Test ID,Title,Steps,Expected");
		const cases = ingestCsv(readFileSync(file, "utf8")).unique;
		expect(cases.map((tc) => [tc.title, tc.steps, tc.expected])).toEqual([
			["Valid login", ROW.steps, "Welcome"],
			["Again", ROW.steps, "Welcome"],
		]);
		expect(() => appendCaseToSheet(file, ROW)).toThrow(/REC-1 already exists/);
	});
});

test("a new workbook gets the Korean case headers", async () => {
	await withDir(async (dir) => {
		const file = join(dir, "qc.xlsx");
		expect(appendCaseToSheet(file, ROW).tab).toBe("시험항목");
		const sheet = await loadSheet(file);
		const book = XLSX.read(readFileSync(file));
		const tab = book.Sheets.시험항목;
		expect(tab && XLSX.utils.sheet_to_json<string[]>(tab, { header: 1 })[0]).toEqual([
			"번호",
			"시험항목",
			"시험절차",
			"예상결과",
		]);
		expect(ingestCsv(sheet.csv).unique.map((tc) => tc.steps)).toEqual([ROW.steps]);
	});
});

test("an existing QC workbook gains the row on its first case tab, not the cover", async () => {
	await withDir(async (dir) => {
		const file = join(dir, "qc.xlsx");
		copyFileSync(join(import.meta.dir, "..", "e2e", "fixtures", "qc-cases.xlsx"), file);
		const before = ingestCsv((await loadSheet(file)).csv).unique.length;
		expect(appendCaseToSheet(file, ROW).tab).toBe("로그인");
		const sheet = await loadSheet(file);
		const cases = ingestCsv(sheet.csv).unique;
		expect(cases).toHaveLength(before + 1);
		expect(cases.at(-1)).toMatchObject({ title: "Valid login", steps: ROW.steps, expected: "Welcome" });
		expect(sheet.tabs.find((t) => t.name === "표지")?.selected).toBe(false);
	});
});
