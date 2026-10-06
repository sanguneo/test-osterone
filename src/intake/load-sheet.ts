/**
 * One way in for every QC source a CLI accepts: an Excel workbook (.xlsx/.xls), a CSV/TSV export, or a
 * Google Sheets URL. Whatever the source, the result is the single merged CSV Studio itself stores, so a
 * case reads the same here as it does after an upload in the browser.
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { toCsvExportUrl } from "./ingest.ts";
import { mergeSheetCsv } from "./merge.ts";
import { convertWorkbook } from "./workbook.ts";

export type SheetKind = "xlsx" | "csv" | "gsheet";

export interface LoadedSheet {
	kind: SheetKind;
	/** The merged CSV of every tab recognized as test cases (or the one CSV/tab given). */
	csv: string;
	/** Workbook tabs with whether each was taken as a case tab; empty for a plain CSV or one Google tab. */
	tabs: { name: string; rows: number; selected: boolean }[];
}

export function isGoogleSheetUrl(source: string): boolean {
	return /^https?:\/\/docs\.google\.com\/spreadsheets\/d\//.test(source.trim());
}

/** Decode CSV/TSV bytes the way Excel and Sheets write them: UTF-16 with a BOM, else strict UTF-8. */
export function decodeText(bytes: Uint8Array): string {
	const encoding =
		bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
	return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

function fromWorkbook(bytes: Uint8Array): Omit<LoadedSheet, "kind"> {
	const workbook = convertWorkbook(bytes);
	return {
		csv: mergeSheetCsv(workbook.filter((sheet) => sheet.isTc)),
		tabs: workbook.map((sheet) => ({ name: sheet.name, rows: sheet.rows, selected: sheet.isTc })),
	};
}

/**
 * Load a QC sheet from a path or a Google Sheets URL.
 *
 * A Google URL that names a tab (`gid=`) reads that tab as CSV. One that does not is read as the whole
 * workbook (`format=xlsx`), so a QC spread across tabs arrives exactly like the same file downloaded as
 * Excel: tabs are selected and merged by the same rules instead of silently keeping only the first.
 */
export async function loadSheet(source: string, fetchImpl: typeof fetch = fetch): Promise<LoadedSheet> {
	if (isGoogleSheetUrl(source)) {
		const wholeWorkbook = !/[#&?]gid=\d+/.test(source);
		const url = wholeWorkbook
			? toCsvExportUrl(source).replace(/format=csv&gid=\d+$/, "format=xlsx")
			: toCsvExportUrl(source);
		const res = await fetchImpl(url);
		if (!res.ok) {
			throw new Error(`Google Sheet fetch failed: ${res.status} — share it as "anyone with the link can view"`);
		}
		if (wholeWorkbook) return { kind: "gsheet", ...fromWorkbook(new Uint8Array(await res.arrayBuffer())) };
		return { kind: "gsheet", csv: decodeText(new Uint8Array(await res.arrayBuffer())), tabs: [] };
	}
	const extension = extname(source).toLowerCase();
	if (extension === ".xlsx" || extension === ".xls") return { kind: "xlsx", ...fromWorkbook(readFileSync(source)) };
	if (extension === ".csv" || extension === ".tsv")
		return { kind: "csv", csv: decodeText(readFileSync(source)), tabs: [] };
	throw new Error(
		`Unsupported sheet format: ${extension || source} (use .xlsx, .xls, .csv, .tsv or a Google Sheets URL)`,
	);
}
