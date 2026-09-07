import { createRequire } from "node:module";
import { toCsv } from "./csv.ts";
import { csvToRawTable, mapColumns } from "./ingest.ts";

const XLSX: typeof import("xlsx") = createRequire(import.meta.url)("xlsx");

export interface WorkbookSheet {
	name: string;
	csv: string;
	rows: number;
	isTc: boolean;
}

/** Convert workbook tabs to the same CSV representation Studio ingests. */
export function convertWorkbook(data: Uint8Array): WorkbookSheet[] {
	const workbook = XLSX.read(data, { type: "array" });
	return workbook.SheetNames.map((name) => {
		const sheet = workbook.Sheets[name];
		if (!sheet) throw new Error(`Workbook tab is missing: ${name}`);
		// A lone real value can live at row 1,048,576. Visit occupied rows, retaining one blank
		// boundary for each gap, rather than allocating and interpreting a million empty records.
		const occupied = Object.entries(sheet)
			.filter(([address, cell]) => !address.startsWith("!") && cell && (cell.f || (cell.v != null && cell.v !== "")))
			.map(([address]) => XLSX.utils.decode_cell(address));
		if (occupied.length === 0) return { name, csv: "", rows: 0, isTc: false };
		const range = occupied.reduce(
			(bounds, cell) => ({
				s: { r: Math.min(bounds.s.r, cell.r), c: Math.min(bounds.s.c, cell.c) },
				e: { r: Math.max(bounds.e.r, cell.r), c: Math.max(bounds.e.c, cell.c) },
			}),
			{ s: { r: Infinity, c: Infinity }, e: { r: 0, c: 0 } },
		);
		const rowNumbers = [...new Set(occupied.map((cell) => cell.r))].sort((a, b) => a - b);
		const rowValues = (r: number): string[] =>
			Array.from({ length: range.e.c - range.s.c + 1 }, (_, index) => {
				const cell = sheet[XLSX.utils.encode_cell({ r, c: range.s.c + index })];
				return cell ? XLSX.utils.format_cell(cell) : "";
			});
		const grid = rowNumbers.map(rowValues);
		const headerOffset = grid.findIndex((row) => new Set(Object.values(mapColumns(row))).size >= 2);
		const headerRow = rowNumbers[headerOffset] ?? -1;
		// Carry merged data context, but not vertically merged header labels: expanding those
		// into Chrome/Edge or role bands invents fake cases named "Title" with a procedure "Steps".
		for (const merge of sheet["!merges"] ?? []) {
			if (merge.s.r <= headerRow) continue;
			const source = sheet[XLSX.utils.encode_cell(merge.s)];
			if (!source) continue;
			for (const r of rowNumbers) {
				if (r < merge.s.r || r > merge.e.r) continue;
				for (let c = merge.s.c; c <= Math.min(merge.e.c, range.e.c); c++) {
					const address = XLSX.utils.encode_cell({ r, c });
					const target = sheet[address];
					if (!target || target.t === "z" || target.v === "") sheet[address] = { ...source };
				}
			}
		}
		const records: string[][] = [];
		for (const [index, r] of rowNumbers.entries()) {
			const previous = rowNumbers[index - 1];
			if (previous !== undefined && r > previous + 1) records.push([]);
			records.push(rowValues(r));
		}
		const csv = toCsv(records);
		const rows = records.filter((row) => row.some((cell) => cell.trim())).length;
		const mapping = mapColumns(csvToRawTable(csv).headers);
		return { name, csv, rows, isTc: Boolean(mapping.step && mapping.expected) };
	}).filter((sheet) => sheet.rows > 1);
}
