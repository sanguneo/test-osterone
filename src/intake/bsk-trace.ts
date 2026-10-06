/**
 * BrowserSkill recording -> one QC case in the canonical step grammar.
 *
 * Input is a Trace v3 as `bsk record` writes it (upstream: crates/bsk-protocol/schema/trace_v3.json,
 * built by apps/extension/src/lib/recording/trace-builder-v3.ts). Two encodings exist: the wire trace
 * (`record stop --json` / `record start --json` stdout) carries each state's VOM text in `states[].body`;
 * the on-disk bundle (`<dir>/trace.json`) replaces it with `states[].page` = "sN.txt" under `<dir>/states/`,
 * which callers pass in as `stateBodies`.
 *
 * Nothing is dropped silently: every recorded step either becomes a grammar step or a warning. A
 * recording never proves an outcome by itself, so the only `verify` derived is text that appeared on the
 * page after the last action and was on no earlier page; without one the case carries no expectation and
 * says so, rather than inventing one.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, join } from "node:path";
import { parseStep } from "../interpret/interpret.ts";
import { establishRuleFromHeaders } from "../interpret/rule.ts";
import { parseCsv, toCsv } from "./csv.ts";
import { decodeText } from "./load-sheet.ts";
import { mapColumns } from "./table.ts";

const XLSX: typeof import("xlsx") = createRequire(import.meta.url)("xlsx");

export const SECRET_PLACEHOLDER = "<secret>";

export interface RecordedCase {
	id: string;
	title: string;
	steps: string[];
	expected: string;
	warnings: string[];
}

export interface TraceToCaseOptions {
	baseUrl?: string;
	title?: string;
	id?: string;
	/** VOM text per state id, for a bundle whose trace.json references `states/sN.txt` instead of inlining it. */
	stateBodies?: Record<string, string>;
}

type Json = Record<string, unknown>;

const CANONICAL_HEADERS = ["Test ID", "Title", "Steps", "Expected"];
const RULE = establishRuleFromHeaders(CANONICAL_HEADERS);
/** Navigations a person starts; the rest (link, form_submit, script) are effects of the action before them. */
const REPLAYED_CAUSES = new Set(["user_typed", "browser", "reload", "history"]);

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

/** Accept a bare trace or the `--json` envelope `{ trace, ... }` that `bsk record` prints. */
function unwrapTrace(input: unknown): Json {
	const candidate = isObject(input) && isObject(input.trace) && !Array.isArray(input.steps) ? input.trace : input;
	if (!isObject(candidate)) throw new Error("bsk trace: expected a JSON object");
	if (candidate.version !== 3) {
		throw new Error(`bsk trace: unsupported trace version ${JSON.stringify(candidate.version)} (expected 3)`);
	}
	if (!Array.isArray(candidate.steps) || !Array.isArray(candidate.states)) {
		throw new Error("bsk trace: missing steps/states arrays");
	}
	return candidate;
}

/** `/path?query#hash` relative to base when same origin (and under base's path); absolute otherwise. */
export function relativePath(url: string, base: string | undefined): { path: string; foreign: boolean } {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return { path: url, foreign: true };
	}
	if (!base) return { path: url, foreign: true };
	const root = new URL(base);
	if (target.origin !== root.origin) return { path: url, foreign: true };
	const prefix = root.pathname.replace(/\/+$/, "");
	let path = target.pathname;
	if (prefix && (path === prefix || path.startsWith(`${prefix}/`))) path = path.slice(prefix.length) || "/";
	return { path: `${path}${target.search}${target.hash}`, foreign: false };
}

interface VomText {
	role: string;
	text: string;
}

/** Named nodes from a state body's VOM section (`  @e1 textbox "Username" [empty]`, `StaticText "Hi"`). */
export function vomTexts(body: string): VomText[] {
	const lines = body.split("\n");
	const marker = lines.indexOf("---");
	const out: VomText[] = [];
	for (const line of marker === -1 ? lines : lines.slice(marker + 1)) {
		const m = line.match(/^\s*(?:@e\d+\s+)?([A-Za-z]+)\s+("(?:[^"\\]|\\.)*")/);
		if (!m?.[1] || !m[2]) continue;
		try {
			const text = JSON.parse(m[2]) as string;
			if (text.trim()) out.push({ role: m[1], text: text.trim() });
		} catch {
			// A malformed name is page data we cannot read; it is simply not a candidate.
		}
	}
	return out;
}

/** Roles whose name is the page telling the user something, in the order an outcome is most likely shown. */
const OUTCOME_ROLES = ["StaticText", "heading", "alert", "status"];

function stateBody(state: Json, bodies: Record<string, string> | undefined): string | undefined {
	const id = str(state.id);
	return str(state.body) ?? (id ? bodies?.[id] : undefined);
}

/** Does the emitted step read back, under the default rule, as the action it was written for? */
function readsBackAs(step: string, kind: string, target?: string, value?: string): boolean {
	const action = parseStep(step, RULE);
	if (action.kind !== kind) return false;
	if (action.kind === "fill") return action.target === target && action.value === value;
	if (action.kind === "click") return action.target === target;
	return true;
}

function quotable(text: string): boolean {
	return !text.includes('"') && !/[\r\n]/.test(text);
}

export function traceToCase(input: unknown, opts: TraceToCaseOptions = {}): RecordedCase {
	const trace = unwrapTrace(input);
	const warnings: string[] = [];
	const steps: string[] = [];
	const states = (trace.states as unknown[]).filter(isObject);
	const stateById = new Map(states.flatMap((s) => (str(s.id) ? [[str(s.id) as string, s] as const] : [])));
	const startUrl = isObject(trace.entry) ? str(trace.entry.start_url) : undefined;
	const firstUrl = startUrl ?? str(states[0]?.url);
	const base = opts.baseUrl ?? (firstUrl ? new URL(firstUrl).origin : undefined);

	const emit = (step: string, kind: string, note: string, target?: string, value?: string) => {
		steps.push(step);
		if (!readsBackAs(step, kind, target, value)) {
			const got = parseStep(step, RULE);
			warnings.push(`${note}: emitted \`${step}\` reads back as ${got.kind}, not ${kind}; edit it before running`);
		}
	};
	const open = (url: string, note: string) => {
		const { path, foreign } = relativePath(url, base);
		if (foreign) warnings.push(`${note}: ${url} is outside base ${base ?? "(none)"}; kept as an absolute URL`);
		emit(`open ${path}`, "goto", note);
	};

	if (firstUrl) open(firstUrl, "entry");
	else warnings.push("entry: trace has no start URL; the case does not open a page first");

	(trace.steps as unknown[]).forEach((raw, index) => {
		const step = isObject(raw) ? raw : {};
		const op = str(step.op) ?? "(none)";
		const note = `step ${typeof step.id === "number" ? step.id : index + 1} (${op})`;
		const target = isObject(step.target) ? step.target : {};
		const name = str(target.name)?.trim();
		switch (op) {
			case "navigate": {
				const to = str(step.to);
				const cause = str(step.cause) ?? "browser";
				if (!to) warnings.push(`${note}: navigation without a URL; skipped`);
				else if (!REPLAYED_CAUSES.has(cause)) {
					warnings.push(`${note}: ${cause} navigation to ${to} follows from the previous action; not replayed`);
				} else open(to, note);
				return;
			}
			case "fill": {
				if (!name) {
					warnings.push(`${note}: field has no accessible name; step not generated`);
					return;
				}
				if (!quotable(name)) {
					warnings.push(`${note}: label ${JSON.stringify(name)} cannot be quoted`);
					return;
				}
				let value = typeof step.value === "string" ? step.value : "";
				if (step.redacted === true) {
					value = SECRET_PLACEHOLDER;
					warnings.push(`${note}: "${name}" was a redacted (password-type) value; replace ${SECRET_PLACEHOLDER}`);
				} else if (!quotable(value)) {
					warnings.push(`${note}: value for "${name}" contains a quote or newline; step not generated`);
					return;
				}
				emit(`enter "${value}" into "${name}"`, "fill", note, name, value);
				return;
			}
			case "click": {
				if (!name) {
					warnings.push(`${note}: element has no accessible name; step not generated`);
					return;
				}
				if (!quotable(name)) {
					warnings.push(`${note}: label ${JSON.stringify(name)} cannot be quoted`);
					return;
				}
				emit(`click "${name}"`, "click", note, name);
				return;
			}
			case "press": {
				const key = str(step.key) ?? "?";
				warnings.push(
					`${note}: key ${key}${name ? ` on "${name}"` : ""} has no step in the grammar; not replayed (add a click if it submitted)`,
				);
				return;
			}
			case "select": {
				const picked = Array.isArray(step.selection)
					? step.selection.filter(isObject).map((o) => str(o.label) ?? str(o.value))
					: [];
				warnings.push(`${note}: selecting ${JSON.stringify(picked)} in "${name ?? "?"}" has no step in the grammar`);
				return;
			}
			case "hover":
			case "scroll":
			case "switch_tab":
				warnings.push(`${note}: ${op} is not replayed by the grammar`);
				return;
			default:
				warnings.push(`${note}: unknown recorded event ${JSON.stringify(raw)}; not converted`);
		}
	});

	const expected = observedOutcome(trace, stateById, opts.stateBodies, warnings);
	if (expected) emit(`verify page shows "${expected}"`, "verify", "outcome");

	const purpose = str(trace.purpose);
	const stamp = (str(trace.recorded_at) ?? new Date().toISOString()).replace(/\D/g, "").slice(0, 14);
	return {
		id: opts.id ?? `REC-${stamp}`,
		title: opts.title ?? purpose ?? `Recorded flow on ${str(states[0]?.title) ?? firstUrl ?? "page"}`,
		steps,
		expected,
		warnings,
	};
}

/**
 * Text present after the last recorded action and on no earlier observation.
 *
 * That is the one outcome the recording actually witnessed. A string that was already on screen
 * would let a broken flow pass, so it never qualifies.
 */
function observedOutcome(
	trace: Json,
	stateById: Map<string, Json>,
	bodies: Record<string, string> | undefined,
	warnings: string[],
): string {
	const steps = (trace.steps as unknown[]).filter(isObject);
	const last = steps.at(-1);
	const finalId = last && isObject(last.result) ? str(last.result.state) : undefined;
	const finalState = finalId ? stateById.get(finalId) : undefined;
	const finalBody = finalState ? stateBody(finalState, bodies) : undefined;
	if (!finalId || !finalBody) {
		warnings.push("outcome: no final observation in the trace; expected left blank (add a verify step)");
		return "";
	}
	const before = new Set<string>();
	for (const [id, state] of stateById) {
		if (id === finalId) continue;
		for (const t of vomTexts(stateBody(state, bodies) ?? "")) before.add(t.text);
	}
	if (stateById.size < 2) {
		warnings.push("outcome: only one observation recorded; nothing changed that could be asserted");
		return "";
	}
	const fresh = vomTexts(finalBody).filter(
		(t) => OUTCOME_ROLES.includes(t.role) && !before.has(t.text) && quotable(t.text) && !t.text.includes("***"),
	);
	// A text that would read back as another action ("Please enter …") cannot be asserted in this grammar.
	const pick = OUTCOME_ROLES.flatMap((role) => fresh.filter((t) => t.role === role)).find((t) =>
		readsBackAs(`verify page shows "${t.text}"`, "verify"),
	);
	if (!pick) {
		warnings.push(`outcome: final state ${finalId} shows no new text; expected left blank (add a verify step)`);
		return "";
	}
	return pick.text;
}

/**
 * Read a `bsk record` bundle: `<dir>/trace.json` (or that file's path) plus its `states/sN.txt` bodies.
 * A state whose page file is missing is reported by `traceToCase` as an unobserved outcome, not guessed.
 */
export function loadTraceBundle(path: string): { trace: unknown; stateBodies: Record<string, string> } {
	const file = extname(path).toLowerCase() === ".json" ? path : join(path, "trace.json");
	const trace = JSON.parse(readFileSync(file, "utf8")) as unknown;
	const inner = isObject(trace) && isObject(trace.trace) ? trace.trace : trace;
	const stateBodies: Record<string, string> = {};
	const states = isObject(inner) && Array.isArray(inner.states) ? inner.states.filter(isObject) : [];
	for (const state of states) {
		const id = str(state.id);
		const page = str(state.page);
		// `page` is a bare file name in the bundle format; anything path-like is not ours to follow.
		if (!id || !page || basename(page) !== page) continue;
		const at = join(dirname(file), "states", page);
		if (existsSync(at)) stateBodies[id] = readFileSync(at, "utf8");
	}
	return { trace, stateBodies };
}

/* ---------------------------------------------------------------------------------------------- */

export interface SheetRow {
	id: string;
	title: string;
	steps: string[];
	expected: string;
}

const KOREAN_HEADERS = ["번호", "시험항목", "시험절차", "예상결과"];

function rowFor(headers: string[], row: SheetRow): string[] {
	const mapping = mapColumns(headers);
	if (!mapping.step || !mapping.expected) {
		throw new Error(`sheet headers ${JSON.stringify(headers)} have no steps/expected column`);
	}
	const values: Record<string, string> = {
		[mapping.step]: row.steps.join("\n"),
		[mapping.expected]: row.expected,
		...(mapping.title ? { [mapping.title]: row.title } : {}),
		...(mapping.id ? { [mapping.id]: row.id } : {}),
	};
	return headers.map((h) => values[h] ?? "");
}

function assertNewId(headers: string[], body: string[][], id: string): void {
	const idColumn = mapColumns(headers).id;
	const at = idColumn ? headers.indexOf(idColumn) : -1;
	if (at >= 0 && body.some((r) => (r[at] ?? "").trim() === id)) {
		throw new Error(`case id ${id} already exists in the sheet; pass a different --id`);
	}
}

function isHeaderRow(row: string[]): boolean {
	const m = mapColumns(row);
	return Boolean(m.step && m.expected);
}

/** Append one case: to a CSV (created with English headers) or to the first case tab of a workbook. */
export function appendCaseToSheet(file: string, row: SheetRow): { file: string; tab?: string } {
	const extension = extname(file).toLowerCase();
	if (extension === ".csv") return appendCsv(file, row);
	if (extension === ".xlsx") return appendXlsx(file, row);
	throw new Error(`Unsupported output format: ${extension || file} (use .xlsx or .csv)`);
}

function appendCsv(file: string, row: SheetRow): { file: string } {
	if (!existsSync(file)) {
		writeFileSync(file, `${toCsv([CANONICAL_HEADERS, rowFor(CANONICAL_HEADERS, row)])}\n`, "utf8");
		return { file };
	}
	const text = decodeText(readFileSync(file));
	const firstLine = text.replace(/^\uFEFF/, "").split("\n")[0] ?? "";
	if (/^sep=/i.test(firstLine) || (!firstLine.includes(",") && /[;\t]/.test(firstLine))) {
		throw new Error(`${file}: only comma-separated CSV can be appended to`);
	}
	const grid = parseCsv(text);
	const headerAt = grid.findIndex(isHeaderRow);
	if (headerAt === -1) throw new Error(`${file}: no header row with steps and expected columns`);
	const headers = grid[headerAt] ?? [];
	assertNewId(headers, grid.slice(headerAt + 1), row.id);
	const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n";
	appendFileSync(file, `${separator}${toCsv([rowFor(headers, row)])}\n`, "utf8");
	return { file };
}

function appendXlsx(file: string, row: SheetRow): { file: string; tab: string } {
	const book = existsSync(file) ? XLSX.read(readFileSync(file), { type: "buffer" }) : XLSX.utils.book_new();
	for (const name of book.SheetNames) {
		const sheet = book.Sheets[name];
		if (!sheet?.["!ref"]) continue;
		const range = XLSX.utils.decode_range(sheet["!ref"]);
		const grid = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "", blankrows: true });
		const headerAt = grid.findIndex((r) => isHeaderRow(r.map(String)));
		if (headerAt === -1) continue;
		const headers = (grid[headerAt] ?? []).map(String);
		assertNewId(
			headers,
			grid.slice(headerAt + 1).map((r) => r.map(String)),
			row.id,
		);
		const r = range.e.r + 1;
		rowFor(headers, row).forEach((value, i) => {
			if (value) sheet[XLSX.utils.encode_cell({ r, c: range.s.c + i })] = { t: "s", v: value };
		});
		sheet["!ref"] = XLSX.utils.encode_range({
			s: range.s,
			e: { r, c: Math.max(range.e.c, range.s.c + headers.length - 1) },
		});
		XLSX.writeFile(book, file, { bookType: "xlsx" });
		return { file, tab: name };
	}
	const name = book.SheetNames.includes("시험항목") ? `시험항목 ${book.SheetNames.length + 1}` : "시험항목";
	XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([KOREAN_HEADERS, rowFor(KOREAN_HEADERS, row)]), name);
	XLSX.writeFile(book, file, { bookType: "xlsx" });
	return { file, tab: name };
}
