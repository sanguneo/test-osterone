import { expect, test } from "bun:test";

import {
	csvToRawTable,
	ingestCsv,
	ingestGoogleSheet,
	mapColumns,
	normalizeTable,
	parseCsv,
	toCsvExportUrl,
} from "../src/ingest.ts";

test("parseCsv handles quotes, embedded commas, and embedded newlines", () => {
	const csv = 'a,b\n"x,y","line1\nline2"\n';
	expect(parseCsv(csv)).toEqual([
		["a", "b"],
		["x,y", "line1\nline2"],
	]);
});

test("parseCsv handles escaped double-quotes", () => {
	expect(parseCsv('"he said ""hi"""')).toEqual([['he said "hi"']]);
});

test("mapColumns maps common headers deterministically (exact before substring)", () => {
	const m = mapColumns(["Test ID", "Title", "Steps", "Expected Result", "Role", "Environment"]);
	expect(m).toEqual({
		id: "Test ID",
		title: "Title",
		step: "Steps",
		expected: "Expected Result",
		role: "Role",
		env: "Environment",
	});
});

const SHEET = [
	"Test ID,Title,Steps,Expected Result,Role,Environment",
	'TC-01,Viewer can sign in,"Navigate to /login\nEnter viewer\nClick Sign in",Signed in as viewer,viewer,staging',
	'TC-02,Wrong password,"Navigate to /login\nEnter wrong-pass\nClick Sign in",Invalid credentials,viewer,staging',
].join("\n");

test("normalizeTable splits steps and derives a stable content-hash caseId", () => {
	const tcs = normalizeTable(csvToRawTable(SHEET));
	expect(tcs).toHaveLength(2);
	const tc0 = tcs[0];
	if (!tc0) throw new Error("missing tc0");
	expect(tc0.title).toBe("Viewer can sign in");
	expect(tc0.steps).toEqual(["Navigate to /login", "Enter viewer", "Click Sign in"]);
	expect(tc0.expected).toBe("Signed in as viewer");
	expect(tc0.role).toBe("viewer");
	expect(tc0.sourceId).toBe("TC-01");
	expect(tc0.caseId).toBe(`TC-${tc0.contentHash}`);
	expect(tc0.contentHash).toMatch(/^[0-9a-f]{16}$/);
});

test("normalizeTable is deterministic: identical input yields identical caseIds", () => {
	const a = normalizeTable(csvToRawTable(SHEET));
	const b = normalizeTable(csvToRawTable(SHEET));
	expect(a).toEqual(b);
	expect(a.map((t) => t.caseId)).toEqual(b.map((t) => t.caseId));
});

test("dedupe removes content-duplicates deterministically (first wins, order preserved)", () => {
	// TC-03 duplicates TC-01's content (only the sheet id differs -> same normalized content).
	const withDup = `${SHEET}\nTC-03,Viewer can sign in,"Navigate to /login\nEnter viewer\nClick Sign in",Signed in as viewer,viewer,staging`;
	const { all, unique, duplicates } = ingestCsv(withDup);
	expect(all).toHaveLength(3);
	expect(unique).toHaveLength(2);
	expect(duplicates).toHaveLength(1);
	expect(duplicates[0]?.index).toBe(2);
	expect(duplicates[0]?.duplicateOfIndex).toBe(0);
});

test("dedupe treats a changed step as a distinct case (hash differs)", () => {
	const changed = `${SHEET}\nTC-04,Viewer can sign in,"Navigate to /login\nEnter viewer\nClick Log in",Signed in as viewer,viewer,staging`;
	const { unique } = ingestCsv(changed);
	expect(unique).toHaveLength(3);
});

test("csvToRawTable ignores fully blank rows", () => {
	const t = csvToRawTable("h1,h2\n,\na,b\n");
	expect(t.rows).toEqual([{ h1: "a", h2: "b" }]);
});

test("toCsvExportUrl builds the CSV export endpoint with gid", () => {
	expect(toCsvExportUrl("https://docs.google.com/spreadsheets/d/ABC123_x/edit#gid=42")).toBe(
		"https://docs.google.com/spreadsheets/d/ABC123_x/export?format=csv&gid=42",
	);
});

test("toCsvExportUrl rejects a non-sheets URL", () => {
	expect(() => toCsvExportUrl("https://example.com/x")).toThrow(/Google Sheets/);
});

test("ingestGoogleSheet fetches the CSV export and ingests it", async () => {
	const csv = "Test ID,Title,Steps,Expected Result\nA,t,Click Go,done";
	const fetchImpl = (async () => new Response(csv, { status: 200 })) as unknown as typeof fetch;
	const { all } = await ingestGoogleSheet("https://docs.google.com/spreadsheets/d/XYZ/edit", fetchImpl);
	expect(all).toHaveLength(1);
	expect(all[0]?.title).toBe("t");
});
