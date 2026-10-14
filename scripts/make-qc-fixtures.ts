/**
 * Regenerates the Excel QC workbooks under e2e/fixtures from the bundled sample cases.
 *
 * They are what a QA team actually hands over: Korean headers, a cover tab that is not test cases,
 * and the cases on their own tab. Every CLI and the Studio e2e suite read them, so "an Excel QC works"
 * is proven against the same bytes everywhere.
 *
 *   bun run fixtures:qc
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { csvToRawTable } from "../src/intake/ingest.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(repo, "e2e", "fixtures");
const HEADERS = ["번호", "대분류", "시험항목", "사전조건", "시험절차", "예상결과", "우선순위"];

function caseRows(csvFile: string, keep: (id: string) => boolean): string[][] {
	const table = csvToRawTable(readFileSync(join(repo, "src", "testing", csvFile), "utf8"));
	return table.rows
		.filter((row) => keep(row["Test ID"] ?? ""))
		.map((row) => [row["Test ID"] ?? "", "로그인", row.Title ?? "", "", row.Steps ?? "", row.Expected ?? "", "상"]);
}

function write(name: string, rows: string[][]): void {
	const book = XLSX.utils.book_new();
	const cover = [
		["문서명", "데모 로그인 QC 시트"],
		["버전", "1.0"],
		["대상", "src/testing/fixture-app.ts (admin / secret)"],
	];
	XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(cover), "표지");
	XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([HEADERS, ...rows]), "로그인");
	writeFileSync(join(out, name), XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
	console.log(`wrote e2e/fixtures/${name} (${rows.length} cases)`);
}

mkdirSync(out, { recursive: true });
write(
	"qc-cases.xlsx",
	caseRows("sample-cases.csv", () => true),
);
write(
	"qc-pass.xlsx",
	caseRows("sample-cases.csv", (id) => id === "TC1" || id === "TC2"),
);
write(
	"qc-cases-nl.xlsx",
	caseRows("sample-cases-nl.csv", () => true),
);
