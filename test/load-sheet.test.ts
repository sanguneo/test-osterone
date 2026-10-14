import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as XLSX from "xlsx";
import { ingestCsv } from "../src/intake/ingest.ts";
import { isGoogleSheetUrl, loadSheet } from "../src/intake/load-sheet.ts";

const CASES = [
	["번호", "대분류", "시험항목", "시험절차", "예상결과"],
	["1", "로그인", "Valid login", 'open /\nclick "Log in"', "Welcome"],
	["2", "로그인", "Invalid login", 'open /\nclick "Log in"', "Invalid credentials"],
];

function workbook(): Uint8Array {
	const book = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(
		book,
		XLSX.utils.aoa_to_sheet([
			["문서명", "로그인 QC"],
			["버전", "1.0"],
		]),
		"표지",
	);
	XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(CASES), "로그인");
	return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}

function stubFetch(body: Uint8Array | string, status = 200) {
	const seen: string[] = [];
	const impl = (async (url: unknown) => {
		seen.push(String(url));
		return new Response(body as BodyInit, { status });
	}) as unknown as typeof fetch;
	return { impl, seen };
}

test("an Excel QC keeps its case tab and leaves the cover tab out", async () => {
	const dir = mkdtempSync(join(tmpdir(), "load-sheet-"));
	try {
		const file = join(dir, "qc.xlsx");
		writeFileSync(file, workbook());
		const sheet = await loadSheet(file);
		expect(sheet.kind).toBe("xlsx");
		expect(sheet.tabs.map((t) => [t.name, t.selected])).toEqual([
			["표지", false],
			["로그인", true],
		]);
		expect(ingestCsv(sheet.csv).unique.map((tc) => tc.title)).toEqual(["Valid login", "Invalid login"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a Google Sheet without a tab id is read as the whole workbook, like a downloaded Excel file", async () => {
	const { impl, seen } = stubFetch(workbook());
	const sheet = await loadSheet("https://docs.google.com/spreadsheets/d/AbC-123_x/edit", impl);
	expect(seen).toEqual(["https://docs.google.com/spreadsheets/d/AbC-123_x/export?format=xlsx"]);
	expect(sheet.kind).toBe("gsheet");
	expect(sheet.tabs.filter((t) => t.selected).map((t) => t.name)).toEqual(["로그인"]);
	expect(ingestCsv(sheet.csv).unique).toHaveLength(2);
});

test("a Google Sheet URL naming a tab reads exactly that tab as CSV", async () => {
	const { impl, seen } = stubFetch("Title,Steps,Expected\nSign in,click Login,Dashboard\n");
	const sheet = await loadSheet("https://docs.google.com/spreadsheets/d/AbC/edit#gid=42", impl);
	expect(seen).toEqual(["https://docs.google.com/spreadsheets/d/AbC/export?format=csv&gid=42"]);
	expect(sheet.tabs).toEqual([]);
	expect(ingestCsv(sheet.csv).unique.map((tc) => tc.title)).toEqual(["Sign in"]);
});

test("a private Google Sheet fails with the status and how to share it", async () => {
	const { impl } = stubFetch("denied", 401);
	await expect(loadSheet("https://docs.google.com/spreadsheets/d/AbC/edit", impl)).rejects.toThrow(
		/401.*anyone with the link/,
	);
});

test("a source that is neither a sheet file nor a Google URL is refused", async () => {
	expect(isGoogleSheetUrl("https://example.com/spreadsheets/d/x")).toBe(false);
	await expect(loadSheet("cases.docx")).rejects.toThrow(/Unsupported sheet format: \.docx/);
});
