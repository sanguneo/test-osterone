/**
 * Read-only intake preflight. It never connects to a model or opens the target application.
 * Accepts an .xlsx/.xls/.csv/.tsv path or a Google Sheets URL (read through `loadSheet`).
 * Exit 0: complete case records; 1: incomplete/unrecognized records; 2: unreadable input.
 */
import { basename } from "node:path";
import { csvToRawTable, ingestCsv, mapColumns } from "../intake/ingest.ts";
import { isGoogleSheetUrl, loadSheet } from "../intake/load-sheet.ts";

async function main(): Promise<number> {
	const source = process.argv.slice(2).find((arg) => arg !== "--");
	if (!source) throw new Error("usage: bun run sheet:check <file.xlsx|file.xls|file.csv|file.tsv|Google Sheets URL>");
	const { csv, tabs } = await loadSheet(source);
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
				file: isGoogleSheetUrl(source) ? source : basename(source),
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

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
		process.exitCode = 2;
	},
);
