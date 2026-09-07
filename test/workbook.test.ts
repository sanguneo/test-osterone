import { expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { csvToRawTable, ingestCsv } from "../src/intake/ingest.ts";
import { convertWorkbook } from "../src/intake/workbook.ts";

function workbookBytes(rows: string[][]): Uint8Array {
	const workbook = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Cases");
	return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

test("workbook conversion preserves cases beyond the old 2000-row preview limit", () => {
	const rows = [["ID", "Title", "Steps", "Expected"]];
	for (let i = 1; i <= 2100; i++) rows.push([String(i), `Case ${i}`, "Click Go", `Result ${i}`]);
	const sheet = convertWorkbook(workbookBytes(rows))[0];
	expect(sheet).toBeDefined();
	const cases = ingestCsv(sheet?.csv ?? "").unique;
	expect(cases).toHaveLength(2100);
	expect(cases.at(-1)?.sourceId).toBe("2100");
});

test("workbook conversion never slices a long quoted expected-result cell", () => {
	const expected = `${'Text with comma, quote " and newline\n'.repeat(600)}END`;
	const rows = [["ID", "Title", "Steps", "Expected"]];
	for (let i = 0; i < 12; i++) rows.push([String(i), `Case ${i}`, "Click Go", expected]);
	const sheet = convertWorkbook(workbookBytes(rows))[0];
	const table = csvToRawTable(sheet?.csv ?? "");
	expect(table.rows).toHaveLength(12);
	expect(table.rows.at(-1)?.Expected).toBe(expected);
});

test("workbook row counts use records instead of lines inside quoted cells", () => {
	const sheet = convertWorkbook(
		workbookBytes([
			["Title", "Steps", "Expected"],
			["Login", "First\nSecond", "A\nB\nC"],
		]),
	)[0];
	expect(sheet?.rows).toBe(2);
});

test("workbook conversion carries merged case context into its continuation rows", () => {
	const workbook = XLSX.utils.book_new();
	const sheet = XLSX.utils.aoa_to_sheet([
		["ID", "Title", "Steps", "Expected"],
		["A", "Login", "Open login", ""],
		["", "", "Click Sign in", "Welcome"],
	]);
	sheet["!merges"] = [
		{ s: { r: 1, c: 0 }, e: { r: 2, c: 0 } },
		{ s: { r: 1, c: 1 }, e: { r: 2, c: 1 } },
	];
	XLSX.utils.book_append_sheet(workbook, sheet, "Cases");
	const bytes: Uint8Array = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
	const table = csvToRawTable(convertWorkbook(bytes)[0]?.csv ?? "");
	expect(table.rows[1]?.ID).toBe("A");
	expect(table.rows[1]?.Title).toBe("Login");
});

test("merged headers do not turn browser and role bands into test cases", () => {
	const workbook = XLSX.utils.book_new();
	const sheet = XLSX.utils.aoa_to_sheet([
		["ID", "Title", "Steps", "Expected", "Test Result", ""],
		["", "", "", "", "Chrome", "Edge"],
		["", "", "", "", "Admin", "Viewer"],
		["1", "Login", "Click Sign in", "Welcome", "Pass", "Pass"],
	]);
	sheet["!merges"] = [0, 1, 2, 3].map((c) => ({ s: { r: 0, c }, e: { r: 2, c } }));
	XLSX.utils.book_append_sheet(workbook, sheet, "Cases");
	const bytes: Uint8Array = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
	const cases = ingestCsv(convertWorkbook(bytes)[0]?.csv ?? "").all;
	expect(cases).toHaveLength(1);
	expect(cases[0]?.sourceId).toBe("1");
});

test("formatted empty worksheet tails do not become a huge CSV payload", () => {
	const workbook = XLSX.utils.book_new();
	const sheet = XLSX.utils.aoa_to_sheet([
		["ID", "Title", "Steps", "Expected"],
		["1", "Login", "Click Sign in", "Welcome"],
	]);
	sheet["!ref"] = "A1:D10000";
	XLSX.utils.book_append_sheet(workbook, sheet, "Cases");
	const bytes: Uint8Array = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
	const converted = convertWorkbook(bytes)[0];
	expect(converted?.csv.length).toBeLessThan(100);
	expect(ingestCsv(converted?.csv ?? "").unique).toHaveLength(1);
});

test("sparse workbook conversion preserves distant values without materializing empty rows", () => {
	const workbook = XLSX.utils.book_new();
	const sheet = XLSX.utils.aoa_to_sheet([
		["File formats", "PDF"],
		["Document", "DOCX"],
	]);
	sheet.B1000 = { t: "s", v: "last-row-value" };
	sheet["!ref"] = "A1:B1000";
	XLSX.utils.book_append_sheet(workbook, sheet, "Reference");
	const bytes: Uint8Array = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
	const converted = convertWorkbook(bytes)[0];
	expect(converted?.csv.length).toBeLessThan(200);
	expect(converted?.csv).toContain("last-row-value");
	expect(converted?.rows).toBe(3);
});
