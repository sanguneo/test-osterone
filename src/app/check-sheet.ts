/**
 * Read-only intake preflight. It never connects to a model or opens the target application.
 * Exit 0: complete case records; 1: incomplete/unrecognized records; 2: unreadable input.
 */
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { csvToRawTable, ingestCsv, mapColumns } from "../intake/ingest.ts";
import { mergeSheetCsv } from "../intake/merge.ts";
import { convertWorkbook } from "../intake/workbook.ts";

function main(): number {
	const file = process.argv[2];
	if (!file) throw new Error("usage: bun run sheet:check <file.xlsx|file.xls|file.csv|file.tsv>");
	const extension = extname(file).toLowerCase();
	if (![".xlsx", ".xls", ".csv", ".tsv"].includes(extension)) {
		throw new Error(`Unsupported sheet format: ${extension}`);
	}
	const bytes = readFileSync(file);
	let csv: string;
	let tabs: { name: string; rows: number; selected: boolean }[];
	if (extension === ".xlsx" || extension === ".xls") {
		const workbook = convertWorkbook(bytes);
		tabs = workbook.map((sheet) => ({ name: sheet.name, rows: sheet.rows, selected: sheet.isTc }));
		csv = mergeSheetCsv(workbook.filter((sheet) => sheet.isTc));
	} else {
		const encoding =
			bytes[0] === 0xff && bytes[1] === 0xfe
				? "utf-16le"
				: bytes[0] === 0xfe && bytes[1] === 0xff
					? "utf-16be"
					: "utf-8";
		csv = new TextDecoder(encoding, { fatal: true }).decode(bytes);
		tabs = [];
	}
	const table = csvToRawTable(csv);
	const mapping = mapColumns(table.headers);
	const result = ingestCsv(csv);
	const incomplete = result.all.flatMap((tc) => {
		const missing: string[] = [];
		if (tc.steps.length === 0) missing.push("steps");
		if (!tc.expected) missing.push("expected");
		return missing.length ? [{ sourceId: tc.sourceId ?? tc.caseId, missing }] : [];
	});
	console.log(
		JSON.stringify(
			{
				file: basename(file),
				tabs,
				headers: table.headers,
				mapping,
				cases: result.all.length,
				unique: result.unique.length,
				duplicates: result.duplicates.length,
				categories: [...new Set(result.unique.map((tc) => tc.category).filter(Boolean))],
				incomplete,
			},
			null,
			2,
		),
	);
	return result.unique.length > 0 && incomplete.length === 0 ? 0 : 1;
}

try {
	process.exitCode = main();
} catch (error) {
	console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
	process.exitCode = 2;
}
