/** Browser-safe, source-format-independent sheet headers and rows. */
import { parseCsv } from "./csv.ts";
import type { RawTable, TcField } from "./schema.ts";

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
	precondition: [
		"precondition",
		"pre-condition",
		"preconditions",
		"given",
		"setup",
		"사전조건",
		"전제조건",
		"선행조건",
	],
	recordedVerdict: [
		"검증 결과",
		"검증결과",
		"시험 결과",
		"시험결과",
		"테스트 결과",
		"테스트결과",
		"수행결과",
		"판정결과",
		"verdict",
		"test result",
		"pass/fail",
	],
	note: ["비고", "note", "notes", "remark", "remarks", "특이사항", "메모", "comment", "comments"],
};

function headerText(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function containsAlias(header: string, alias: string): boolean {
	// Short English aliases such as "no", "id", and "name" must be words, not parts of Notes,
	// Validity, or Username. Korean compounds still accept substring matching.
	return /^[a-z /-]+$/.test(alias)
		? new RegExp(`(?:^|[^a-z0-9])${alias}(?:$|[^a-z0-9])`).test(header)
		: header.includes(alias);
}

/** Exact semantic headers win over incidental substrings; alias order breaks ties. */
export function mapColumns(headers: string[]): Partial<Record<TcField, string>> {
	const mapping: Partial<Record<TcField, string>> = {};
	const lower = headers.map((raw) => ({ raw, low: headerText(raw).toLowerCase() }));
	if (lower.every((header) => !header.low)) return mapping;
	for (const field of Object.keys(FIELD_ALIASES) as TcField[]) {
		const aliases = FIELD_ALIASES[field];
		const exact = aliases.map((alias) => lower.find((h) => h.low === alias)).find(Boolean);
		const hit = exact ?? aliases.map((alias) => lower.find((h) => containsAlias(h.low, alias))).find(Boolean);
		if (hit) mapping[field] = hit.raw;
	}
	// Only use a precondition as a procedure when no actual procedure was found, including
	// compound procedure headers such as 상세 시험절차.
	if (!mapping.step) mapping.step = lower.find((h) => h.low.includes("사전조건"))?.raw;
	if (!mapping.step) delete mapping.step;
	if (mapping.precondition === mapping.step) delete mapping.precondition;
	for (const field of ["recordedVerdict", "note"] as const) {
		const claimed = mapping[field];
		if (
			claimed &&
			[mapping.expected, mapping.step, mapping.title, mapping.precondition, mapping.category].includes(claimed)
		) {
			delete mapping[field];
		}
	}
	return mapping;
}

function headerScore(row: readonly string[]): number {
	const mapping = mapColumns([...row]);
	if (!mapping.title && !mapping.step && !mapping.expected) return 0;
	return new Set(Object.values(mapping)).size;
}

/** Keep physical duplicate columns addressable; collect them when reading a canonical field. */
export function tableCell(table: RawTable, row: Record<string, string>, header: string): string {
	return (table.columnGroups?.[header] ?? [header])
		.map((key) => row[key] ?? "")
		.filter((value) => value.trim())
		.join("\n");
}

/** Locate the first recognizable header, flatten child header bands, and retain all columns. */
export function gridToRawTable(grid: readonly (readonly string[])[]): RawTable {
	const first = grid.findIndex((row) => row.some((cell) => cell.trim()));
	if (first === -1) return { headers: [], rows: [] };
	const detected = grid.findIndex((row) => headerScore(row) >= 2);
	const start = detected === -1 ? first : detected;
	let names = [...(grid[start] ?? [])].map(headerText);
	let end = start + 1;
	const bands = [names];
	while (end < grid.length) {
		const child = grid[end] ?? [];
		const populated = child.filter((value) => value.trim());
		// A child band must itself look like labels, not a case whose title happens to be "Login".
		if (headerScore(child) < 2 || !populated.every((value) => Object.values(mapColumns([value])).length > 0)) break;
		const combined = Array.from(
			{ length: Math.max(names.length, child.length) },
			(_, i) => headerText(child[i] ?? "") || names[i] || "",
		);
		if (headerScore(combined) <= headerScore(names)) break;
		names = combined;
		bands.push(child.map(headerText));
		end++;
	}
	const width = grid.slice(start).reduce((max, row) => Math.max(max, row.length), names.length);
	const used = new Set<string>();
	const groups: Record<string, string[]> = Object.create(null);
	const headers = Array.from({ length: width }, (_, i) => {
		const base = names[i] || `Column ${i + 1}`;
		let key = base;
		let suffix = 2;
		while (used.has(key) || (key !== base && names.includes(key))) key = `${base} [${suffix++}]`;
		used.add(key);
		groups[base] ??= [];
		groups[base].push(key);
		return key;
	});
	const columnGroups = Object.fromEntries(Object.entries(groups).filter(([, keys]) => keys.length > 1));
	const rows: Record<string, string>[] = [];
	const rowBreaks: number[] = [];
	for (const values of grid.slice(end)) {
		const repeated = [...bands, names].some(
			(band) =>
				values.length <= width &&
				band.every((name, i) => headerText(values[i] ?? "").toLowerCase() === name.toLowerCase()) &&
				values.slice(band.length).every((value) => !value.trim()),
		);
		if (!values.some((value) => value.trim()) || repeated) {
			if (rows.length && rowBreaks.at(-1) !== rows.length) rowBreaks.push(rows.length);
			continue;
		}
		rows.push(Object.fromEntries(headers.map((header, i) => [header, (values[i] ?? "").trim()])));
	}
	return {
		headers,
		rows,
		...(Object.keys(columnGroups).length ? { columnGroups } : {}),
		...(rowBreaks.length ? { rowBreaks } : {}),
	};
}

export function csvToRawTable(text: string): RawTable {
	return gridToRawTable(parseCsv(text));
}
