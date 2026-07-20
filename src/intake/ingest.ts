/**
 * Intake: parse a sheet into a RawTable, map columns onto canonical fields,
 * normalize deterministically, and dedupe by content hash. Everything here is
 * pure + deterministic so re-runs produce identical caseIds and dedupe results.
 */

import { createHash } from "node:crypto";

import type { NormalizedTC, RawTable, TcField } from "./schema.ts";

/** RFC4180-ish CSV parser: handles quotes, embedded commas, and embedded newlines. */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (inQuotes) {
			if (ch === '"') {
				if (s[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ",") {
			row.push(field);
			field = "";
		} else if (ch === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else {
			field += ch;
		}
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

/** First non-empty grid row is the header; remaining rows become header-keyed objects. */
export function csvToRawTable(text: string): RawTable {
	const grid = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
	const first = grid[0];
	if (!first) return { headers: [], rows: [] };
	const headers = first.map((h) => h.trim());
	const rows = grid.slice(1).map((r) => {
		const obj: Record<string, string> = {};
		headers.forEach((h, i) => {
			obj[h] = (r[i] ?? "").trim();
		});
		return obj;
	});
	return { headers, rows };
}

const FIELD_ALIASES: Record<TcField, string[]> = {
	id: ["test id", "tc id", "case id", "tcid", "id", "번호", "순번"],
	title: ["title", "name", "summary", "test case", "scenario", "소분류", "테스트 항목", "항목", "제목", "시나리오명"],
	step: [
		"steps",
		"step",
		"actions",
		"action",
		"procedure",
		"사전조건",
		"절차",
		"단계",
		"재현 절차",
		"테스트 절차",
		"시나리오",
	],
	expected: ["expected result", "expected", "result", "assertion", "예상결과", "기대결과", "기대 결과"],
	priority: ["priority", "prio", "severity", "중요도", "우선순위"],
	role: ["role", "persona", "account", "user", "담당자"],
	env: ["environment", "env", "stage", "환경"],
};

/** Deterministic header→field mapping: exact alias match first, then substring. */
export function mapColumns(headers: string[]): Partial<Record<TcField, string>> {
	const mapping: Partial<Record<TcField, string>> = {};
	const lower = headers.map((h) => ({ raw: h, low: h.toLowerCase().trim() }));
	for (const field of Object.keys(FIELD_ALIASES) as TcField[]) {
		const aliases = FIELD_ALIASES[field];
		const exact = lower.find((h) => aliases.includes(h.low));
		const hit = exact ?? lower.find((h) => aliases.some((a) => h.low.includes(a)));
		if (hit) mapping[field] = hit.raw;
	}
	return mapping;
}

function normText(value: string): string {
	return value
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.trim()
		.replace(/[ \t]+/g, " ");
}

function splitSteps(cell: string): string[] {
	return normText(cell)
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

function contentHash(parts: unknown): string {
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/** Map + normalize rows into NormalizedTC[] with deterministic content hashes + caseIds. */
export function normalizeTable(
	table: RawTable,
	mapping: Partial<Record<TcField, string>> = mapColumns(table.headers),
): NormalizedTC[] {
	const cell = (row: Record<string, string>, field: TcField): string => {
		const header = mapping[field];
		return header ? (row[header] ?? "") : "";
	};
	return table.rows.map((row) => {
		const title = normText(cell(row, "title"));
		const steps = splitSteps(cell(row, "step"));
		const expected = normText(cell(row, "expected"));
		const role = normText(cell(row, "role")) || null;
		const env = normText(cell(row, "env")) || null;
		const priority = normText(cell(row, "priority")) || null;
		const sourceId = normText(cell(row, "id")) || null;
		const hash = contentHash([title, steps, expected, role, env]);
		return { caseId: `TC-${hash}`, sourceId, title, steps, expected, priority, role, env, contentHash: hash };
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

/** Convenience: CSV text → normalized + deduped cases. `mappingOverride` (e.g. an AI-refined
 * rule.mapping) wins over auto-detected columns, so a conversationally-established sheet
 * interpretation actually drives ingestion. */
export function ingestCsv(
	text: string,
	mappingOverride: Partial<Record<TcField, string>> = {},
): { all: NormalizedTC[] } & DedupeResult {
	const table = csvToRawTable(text);
	const mapping = { ...mapColumns(table.headers), ...mappingOverride };
	const all = normalizeTable(table, mapping);
	return { all, ...dedupe(all) };
}

/** Convert a Google Sheets URL to its read-only CSV export URL (auth/permission is a Follow-up). */
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
