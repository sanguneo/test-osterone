import { toCsv } from "./csv.ts";
import type { TcField } from "./schema.ts";
import { csvToRawTable, mapColumns, tableCell } from "./table.ts";

const FIELDS: readonly TcField[] = [
	"id",
	"title",
	"step",
	"expected",
	"priority",
	"role",
	"env",
	"precondition",
	"recordedVerdict",
	"note",
];

/** Merge selected workbook tabs into the single sheet stored by Studio. */
export function mergeSheetCsv(tabs: readonly { name: string; csv: string }[]): string {
	const tables = tabs.map((tab) => {
		const table = csvToRawTable(tab.csv);
		return { name: tab.name, table, mapping: mapColumns(table.headers), destinations: new Map<string, string>() };
	});
	const headers = ["category"];
	const byField = new Map<TcField, string>();
	const extraHeaders = new Map<string, string>();
	const addHeader = (name: string): string => {
		let unique = name;
		for (let suffix = 2; headers.includes(unique); suffix++) unique = `${name} (${suffix})`;
		headers.push(unique);
		return unique;
	};
	// Each tab has its own schema. Equivalent fields share a destination, while unknown columns
	// remain available to subsequent mapping and review instead of disappearing behind tab one.
	for (const tab of tables) {
		const grouped = new Set<string>();
		for (const field of FIELDS) {
			const source = tab.mapping[field];
			if (!source) continue;
			let destination = byField.get(field);
			if (!destination) {
				destination = addHeader(source);
				byField.set(field, destination);
			}
			tab.destinations.set(source, destination);
			for (const member of tab.table.columnGroups?.[source] ?? []) grouped.add(member);
		}
		for (const source of tab.table.headers) {
			if (tab.destinations.has(source) || grouped.has(source) || source === tab.mapping.category) continue;
			let destination = extraHeaders.get(source);
			if (!destination) {
				destination = addHeader(source);
				extraHeaders.set(source, destination);
			}
			tab.destinations.set(source, destination);
		}
	}
	const merged: string[][] = [headers];
	for (const tab of tables) {
		const breaks = new Set(tab.table.rowBreaks);
		for (const [index, row] of tab.table.rows.entries()) {
			if (breaks.has(index)) merged.push([]);
			const category = tab.mapping.category ? tableCell(tab.table, row, tab.mapping.category).trim() : "";
			const values = new Map<string, string>([
				["category", category && category !== tab.name ? `${tab.name} / ${category}` : tab.name],
			]);
			for (const [source, destination] of tab.destinations) {
				values.set(destination, tableCell(tab.table, row, source));
			}
			merged.push(headers.map((header) => values.get(header) ?? ""));
		}
		merged.push([]);
	}
	return toCsv(merged);
}
