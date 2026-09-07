/** Deterministic normalization and content-hash deduplication over browser-safe sheet tables. */
import { createHash } from "node:crypto";
import type { NormalizedTC, RawTable, TcField } from "./schema.ts";
import { csvToRawTable, mapColumns, tableCell } from "./table.ts";

export { parseCsv } from "./csv.ts";
export { csvToRawTable, gridToRawTable, mapColumns, tableCell } from "./table.ts";

function normText(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function splitSteps(cell: string): string[] {
	return normText(cell)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function contentHash(parts: unknown): string {
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/** Fold only adjacent, explicitly identified cases; do not guess that every untitled row belongs
 * to its predecessor. Context conflicts and source separators end a continuation group. */
function continuationRows(table: RawTable, mapping: Partial<Record<TcField, string>>): Record<string, string>[] {
	if (!mapping.id) return table.rows;
	const cell = (row: Record<string, string>, field: TcField) =>
		mapping[field] ? tableCell(table, row, mapping[field]) : "";
	const breaks = new Set(table.rowBreaks);
	const rows: Record<string, string>[] = [];
	let previous: Record<string, string> | undefined;
	let lastSource: Record<string, string> | undefined;
	for (const [index, source] of table.rows.entries()) {
		if (breaks.has(index)) previous = undefined;
		const id = cell(source, "id");
		const title = cell(source, "title");
		const sameCase =
			previous &&
			cell(previous, "id") &&
			(id === cell(previous, "id") || (!id && !title)) &&
			(!title || title === cell(previous, "title"));
		const context = previous;
		const conflicting =
			context &&
			(["category", "role", "env", "precondition", "priority", "recordedVerdict"] as const).some(
				(field) => cell(source, field) && cell(source, field) !== cell(context, field),
			);
		const hasProcedure = cell(source, "step") || cell(source, "expected");
		const repeated = lastSource && table.headers.every((header) => source[header] === lastSource?.[header]);
		if (previous && sameCase && !conflicting && hasProcedure && !repeated) {
			for (const field of ["step", "expected", "note"] as const) {
				const header = mapping[field];
				if (!header) continue;
				const value = cell(source, field);
				const prior = cell(previous, field);
				if (value && (field === "step" || value !== prior)) {
					previous[header] = [prior, value].filter(Boolean).join("\n");
					for (const key of table.columnGroups?.[header] ?? []) {
						if (key !== header) previous[key] = "";
					}
				}
			}
		} else {
			previous = { ...source };
			rows.push(previous);
		}
		lastSource = source;
	}
	return rows;
}

/** Map + normalize rows into NormalizedTC[] with deterministic content hashes + caseIds. */
export function normalizeTable(
	table: RawTable,
	mapping: Partial<Record<TcField, string>> = mapColumns(table.headers),
): NormalizedTC[] {
	const cell = (row: Record<string, string>, field: TcField): string => {
		const header = mapping[field];
		return header ? tableCell(table, row, header) : "";
	};
	return continuationRows(table, mapping).map((row) => {
		const rawTitle = normText(cell(row, "title"));
		let title = rawTitle;
		let category = normText(cell(row, "category")) || null;
		if (!category) {
			const m = rawTitle.match(/^\[\s*([^\]]+?)\s*\]\s*(.+)$/);
			if (m?.[1] && m[2]) {
				category = m[1];
				title = m[2];
			}
		}
		const steps = splitSteps(cell(row, "step"));
		const expected = normText(cell(row, "expected"));
		const role = normText(cell(row, "role")) || null;
		const env = normText(cell(row, "env")) || null;
		const priority = normText(cell(row, "priority")) || null;
		const sourceId = normText(cell(row, "id")) || null;
		const precondition = normText(cell(row, "precondition")) || undefined;
		const recordedVerdict = normText(cell(row, "recordedVerdict")) || undefined;
		const note = normText(cell(row, "note")) || undefined;
		// Context changes what is exercised. Old baselines must not approve a different starting
		// state or another tab's identically worded case. Context-free legacy IDs stay unchanged.
		const identity: unknown[] = [title, steps, expected, role, env];
		if (category || precondition) identity.push({ category, precondition: precondition ?? null });
		const hash = contentHash(identity);
		return {
			caseId: `TC-${hash}`,
			sourceId,
			title,
			steps,
			expected,
			...(precondition ? { precondition } : {}),
			...(recordedVerdict ? { recordedVerdict } : {}),
			...(note ? { note } : {}),
			priority,
			role,
			env,
			category,
			contentHash: hash,
		};
	});
}

export interface DedupeResult {
	unique: NormalizedTC[];
	duplicates: { caseId: string; duplicateOfIndex: number; index: number }[];
}

/** Remove content-duplicate cases deterministically (first occurrence wins, input order preserved). */
export function dedupe(tcs: NormalizedTC[]): DedupeResult {
	const firstIndexByHash = new Map<string, number>();
	const unique: NormalizedTC[] = [];
	const duplicates: { caseId: string; duplicateOfIndex: number; index: number }[] = [];
	tcs.forEach((tc, index) => {
		const firstIndex = firstIndexByHash.get(tc.contentHash);
		if (firstIndex === undefined) {
			firstIndexByHash.set(tc.contentHash, index);
			unique.push(tc);
		} else {
			duplicates.push({ caseId: tc.caseId, duplicateOfIndex: firstIndex, index });
		}
	});
	return { unique, duplicates };
}

/** CSV text to cases. Only overrides naming an existing column may replace auto-detection. */
export function ingestCsv(
	text: string,
	mappingOverride: Partial<Record<TcField, string>> = {},
): { all: NormalizedTC[] } & DedupeResult {
	const table = csvToRawTable(text);
	const overrides = Object.fromEntries(
		Object.entries(mappingOverride).filter(([, header]) => table.headers.includes(header)),
	);
	const mapping = { ...mapColumns(table.headers), ...overrides };
	const mapped = normalizeTable(table, mapping);
	// Only prune empty content when the sheet actually has identifiable content columns.
	const canJudgeEmptiness = !!(mapping.title || mapping.step || mapping.expected);
	const all = canJudgeEmptiness ? mapped.filter((tc) => tc.title || tc.steps.length > 0 || tc.expected) : mapped;
	return { all, ...dedupe(all) };
}

/** Convert a Google Sheets URL to its read-only CSV export URL. */
export function toCsvExportUrl(sheetUrl: string): string {
	const id = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1];
	if (!id) throw new Error("not a Google Sheets URL");
	const gid = sheetUrl.match(/[#&?]gid=(\d+)/)?.[1] ?? "0";
	return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

/** Fetch a public / link-readable Google Sheet as CSV and ingest it. */
export async function ingestGoogleSheet(
	sheetUrl: string,
	fetchImpl: typeof fetch = fetch,
	mappingOverride: Partial<Record<TcField, string>> = {},
): Promise<{ all: NormalizedTC[] } & DedupeResult> {
	const res = await fetchImpl(toCsvExportUrl(sheetUrl));
	if (!res.ok) throw new Error(`gsheet fetch failed: ${res.status}`);
	return ingestCsv(await res.text(), mappingOverride);
}
