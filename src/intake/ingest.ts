/**
 * Intake: parse a sheet into a RawTable, map columns onto canonical fields,
 * normalize deterministically, and dedupe by content hash. Everything here is
 * pure + deterministic so re-runs produce identical caseIds and dedupe results.
 */

import { createHash } from "node:crypto";

import { parseCsv } from "./csv.ts";
import type { NormalizedTC, RawTable, TcField } from "./schema.ts";

export { parseCsv };

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
	id: ["test id", "tc id", "case id", "tcid", "id", "no", "번호", "순번"],
	title: ["title", "name", "summary", "test case", "scenario", "소분류", "테스트 항목", "항목", "제목", "시나리오명"],
	step: [
		"steps",
		"step",
		"actions",
		"action",
		"procedure",
		"test procedure",
		"시험절차",
		"테스트 절차",
		"재현 절차",
		"절차",
		"단계",
		"시나리오",
		// Last resort only: a precondition describes the starting state, not what to do. A sheet that
		// carries both (사전조건 + 시험절차) must map its *procedure* column, whichever comes first.
		"사전조건",
	],
	expected: [
		"expected result",
		"test expected result",
		"expected",
		"result",
		"assertion",
		"예상결과",
		"기대결과",
		"기대 결과",
	],
	priority: ["priority", "prio", "severity", "중요도", "우선순위"],
	role: ["role", "persona", "account", "user", "담당자"],
	env: ["environment", "env", "stage", "환경"],
	category: ["category", "분류", "카테고리", "구분", "그룹", "group", "대분류", "중분류", "메뉴", "menu"],
};

/**
 * Deterministic header→field mapping. **Alias priority decides**, not column order: with an
 * exact-match-first-across-all-aliases rule a sheet listing 사전조건 before 시험절차 would map its
 * steps to the precondition and silently never execute the real procedure. Within one alias, an
 * exact header match still beats a substring match.
 */
export function mapColumns(headers: string[]): Partial<Record<TcField, string>> {
	const mapping: Partial<Record<TcField, string>> = {};
	const lower = headers.map((h) => ({ raw: h, low: h.toLowerCase().trim() }));
	for (const field of Object.keys(FIELD_ALIASES) as TcField[]) {
		for (const alias of FIELD_ALIASES[field]) {
			const hit = lower.find((h) => h.low === alias) ?? lower.find((h) => h.low.includes(alias));
			if (hit) {
				mapping[field] = hit.raw;
				break;
			}
		}
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
		const rawTitle = normText(cell(row, "title"));
		let title = rawTitle;
		let category = normText(cell(row, "category")) || null;
		if (!category) {
			// Fall back to a `[말머리]` title prefix as the category, stripping it from the title.
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
		const hash = contentHash([title, steps, expected, role, env]);
		return { caseId: `TC-${hash}`, sourceId, title, steps, expected, priority, role, env, category, contentHash: hash };
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
	// Spreadsheets carry sub-header and spacer rows (a "Chrome | Edge" band under the real header,
	// section separators). Those normalize to a case with nothing to do and nothing to check, which
	// would sit in the review queue as permanent noise — a row with no title, no steps and no
	// expected result is not a test case. Only prune when the mapping resolved one of those columns:
	// with nothing mapped, "empty" says nothing about the row.
	const mapped = normalizeTable(table, mapping);
	const canJudgeEmptiness = !!(mapping.title || mapping.step || mapping.expected);
	const all = canJudgeEmptiness ? mapped.filter((tc) => tc.title || tc.steps.length > 0 || tc.expected) : mapped;
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
