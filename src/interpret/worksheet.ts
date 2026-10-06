/**
 * 작업시트화: a QC written in free natural language -> a work sheet whose steps are in the canonical,
 * deterministically executable grammar, with the original text kept beside each step.
 *
 * The model only proposes the rewrite. Everything that decides whether a row may be executed is checked
 * here, deterministically: the grammar, the one-to-one mapping back to the original steps, and that every
 * value, label and checked text is traceable to the source instead of invented. The expected result is
 * copied from the source, never generated. A row that fails any check is `needs_review`, and its
 * executable steps start with a line the engine cannot interpret, so running it can never yield a pass.
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname } from "node:path";
import { toCsv } from "../intake/csv.ts";
import type { NormalizedTC } from "../intake/schema.ts";
import type { ModelClient } from "../model/model-client.ts";
import { type PageAction, parseStep } from "./interpret.ts";
import { establishRuleFromHeaders, extractJsonObject } from "./rule.ts";

export interface WorksheetRow {
	sourceId: string;
	category: string;
	title: string;
	precondition: string;
	originalSteps: string[];
	steps: string[];
	expected: string;
	status: "ok" | "needs_review";
	evidence: string;
}

export interface WorksheetInput {
	cases: NormalizedTC[];
	spec?: string;
	codeContext?: string;
	model: ModelClient;
}

/** Output header row. Mapped by `mapColumns`: step -> 시험절차 (원문 matches no field alias). */
export const WORKSHEET_HEADERS = [
	"번호",
	"대분류",
	"시험항목",
	"사전조건",
	"원문",
	"시험절차",
	"예상결과",
	"해석상태",
	"근거",
] as const;

/**
 * First executable line of a `needs_review` row. It contains no intent keyword of the default rule, so
 * the engine parses it as `unknown`, skips it with a heal event, and caps the case at `needs_review`.
 */
export const REVIEW_MARKER = "[검토 필요] 해석 미확정 - 원문 참조";

export const WORKSHEET_BATCH_SIZE = 10;

const rule = establishRuleFromHeaders([...WORKSHEET_HEADERS], "worksheet");

const SYSTEM = [
	"You convert manual QA test cases written in free natural language into test-osterone's canonical step grammar.",
	"The canonical grammar has exactly four forms, one action per line:",
	"  open /path",
	'  enter "<value>" into "<label>"',
	'  click "<label>"',
	'  verify page shows "<text>"',
	'Examples: `open /`, `enter "admin" into "Username"`, `click "Log in"`, `verify page shows "Welcome"`.',
	"Rules:",
	"1. Rewrite each original step into canonical form, preserving order one-to-one. Every canonical step names the",
	"   0-based index of the original step it comes from in `source`.",
	"2. Split an original step into two canonical steps ONLY when it clearly holds two actions, and say so in evidence",
	'   (use the word "split"). Never merge steps. NEVER invent a step that has no original, never drop one, and never',
	"   change a step's intent.",
	'3. Resolve vague references ("the login button", "the welcome message") to the exact label or text found in the',
	"   CODE CONTEXT or SPEC. A label that does not exist in the code or spec must be kept EXACTLY AS WRITTEN in the",
	"   original — do NOT correct it to an existing control; a missing control must stay detectable.",
	"4. `enter` values come from the original step (or the precondition/spec when the step names them indirectly).",
	"5. `verify page shows` text must be a short literal the page displays, taken from the original step or the",
	"   expected result — the shortest distinctive phrase, never a sentence you made up.",
	"6. `open` takes an app-internal path starting with '/'; the home/main/login page of a single-page app is `/`.",
	'Respond ONLY with JSON: {"cases":[{"key":"<key>","steps":[{"source":0,"step":"open /"}],',
	'"evidence":"one short sentence per resolved reference: what you mapped to what, and from where"}]}.',
].join("\n");

function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

function loose(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function contains(haystacks: readonly string[], needle: string): boolean {
	const n = loose(needle);
	return n.length > 0 && haystacks.some((h) => loose(h).includes(n));
}

/** Strict canonical grammar; the engine's own parse must then agree with it exactly. */
function canonicalAction(step: string): PageAction | null {
	let m = step.match(/^open (\/\S*)$/);
	if (m?.[1]) return { kind: "goto", path: m[1] };
	m = step.match(/^enter "([^"]*)" into "([^"]+)"$/);
	if (m?.[2] !== undefined) return { kind: "fill", target: m[2], value: m[1] ?? "" };
	m = step.match(/^click "([^"]+)"$/);
	if (m?.[1]) return { kind: "click", target: m[1] };
	m = step.match(/^verify page shows "([^"]+)"$/);
	if (m?.[1]) return { kind: "verify", text: step };
	return null;
}

interface ProposedStep {
	source: unknown;
	step: unknown;
}

interface CaseContext {
	tc: NormalizedTC;
	spec: string;
	codeContext: string;
}

/** Every reason this proposal may not be executed as the case's steps; empty when it may. */
function validate(proposed: ProposedStep[], evidence: string, ctx: CaseContext): string[] {
	const { tc, spec, codeContext } = ctx;
	const originals = tc.steps;
	const reasons: string[] = [];
	if (originals.length === 0) return ["원문에 시험절차가 없음"];
	if (proposed.length === 0) return ["모델이 시험절차를 돌려주지 않음"];
	const sources: number[] = [];
	proposed.forEach((p, k) => {
		const n = k + 1;
		const source = p.source;
		const step = typeof p.step === "string" ? p.step.trim() : "";
		if (typeof source !== "number" || !Number.isInteger(source) || source < 0 || source >= originals.length) {
			reasons.push(`${n}번 절차의 원문 대응이 없음(지어낸 절차일 수 있음)`);
			return;
		}
		sources.push(source);
		const original = originals[source] ?? "";
		const action = canonicalAction(step);
		if (!action) {
			reasons.push(`${n}번 절차가 표준 문법이 아님: ${step || "(빈 절차)"}`);
			return;
		}
		const parsed = parseStep(step, rule);
		if (JSON.stringify(parsed) !== JSON.stringify(action)) {
			reasons.push(`${n}번 절차를 엔진이 다르게 해석함(${parsed.kind}): ${step}`);
			return;
		}
		if (action.kind === "goto" && action.path !== "/" && !contains([original, spec, codeContext], action.path)) {
			reasons.push(`${n}번 절차의 경로 ${action.path}가 원문·기획서·코드 어디에도 없음`);
		}
		if (action.kind === "fill" && !contains([original, tc.precondition ?? "", spec], action.value)) {
			reasons.push(`${n}번 절차의 입력값 "${action.value}"이 원문·사전조건·기획서에 없음`);
		}
		if (
			(action.kind === "fill" || action.kind === "click") &&
			!contains([original, spec, codeContext], action.target)
		) {
			reasons.push(`${n}번 절차의 라벨 "${action.target}"이 원문·기획서·코드 어디에도 없음`);
		}
		if (action.kind === "verify") {
			const text = step.match(/"([^"]+)"/)?.[1] ?? "";
			if (!contains([original, tc.expected], text)) {
				reasons.push(`${n}번 절차의 확인 문구 "${text}"가 원문·예상결과에 없음`);
			}
		}
	});
	if (reasons.length > 0) return reasons;
	// Order and coverage: sources start at 0, end at the last original, and never skip or go back.
	for (let k = 0; k < sources.length; k++) {
		const prev = k === 0 ? -1 : (sources[k - 1] ?? -1);
		const cur = sources[k] ?? -1;
		if (cur < prev || cur > prev + 1) {
			reasons.push(`절차 순서/대응이 원문과 맞지 않음(원문 ${prev + 2}번 이후 ${cur + 1}번)`);
			break;
		}
	}
	if (reasons.length === 0 && sources.at(-1) !== originals.length - 1) {
		reasons.push(`원문 ${originals.length}개 절차 중 ${(sources.at(-1) ?? -1) + 1}개까지만 대응됨`);
	}
	const split = sources.some((s, k) => k > 0 && s === sources[k - 1]);
	if (split && !/split|분리|나눔|나눠|나누/i.test(evidence)) {
		reasons.push("원문 1개 절차가 여러 절차로 늘었으나 분리 근거가 없음(지어낸 절차일 수 있음)");
	}
	// The intent of each original step the engine can classify must survive the rewrite.
	if (reasons.length === 0) {
		originals.forEach((original, j) => {
			const kind = parseStep(original, rule).kind;
			if (kind === "unknown") return;
			const kinds = proposed
				.filter((p) => p.source === j)
				.map((p) => canonicalAction(String(p.step).trim())?.kind ?? "unknown");
			if (!kinds.includes(kind)) reasons.push(`원문 ${j + 1}번 절차의 의도(${kind})가 바뀜: ${kinds.join(", ")}`);
		});
	}
	return reasons;
}

function baseRow(tc: NormalizedTC): Omit<WorksheetRow, "steps" | "status" | "evidence"> {
	return {
		sourceId: tc.sourceId ?? tc.caseId,
		category: tc.category ?? "",
		title: tc.title,
		precondition: tc.precondition ?? "",
		originalSteps: [...tc.steps],
		expected: tc.expected,
	};
}

function reviewRow(tc: NormalizedTC, proposedSteps: string[], evidence: string, reasons: string[]): WorksheetRow {
	const why = `검토 사유: ${reasons.join("; ")}`;
	return {
		...baseRow(tc),
		steps: [REVIEW_MARKER, ...proposedSteps],
		status: "needs_review",
		evidence: evidence ? `${evidence} | ${why}` : why,
	};
}

function userPrompt(batch: NormalizedTC[], spec: string, codeContext: string): string {
	const cases = batch.map((tc, i) => ({
		key: String(i),
		title: tc.title,
		precondition: tc.precondition ?? "",
		steps: tc.steps.map((step, source) => ({ source, original: step })),
		expected: tc.expected,
	}));
	return [
		`SPEC (기획서):\n${spec || "(none)"}`,
		`CODE CONTEXT:\n${codeContext || "(none)"}`,
		`CASES:\n${JSON.stringify(cases, null, 2)}`,
	].join("\n\n");
}

/** Rewrite natural-language cases into canonical steps, then validate every row deterministically. */
export async function toWorksheet(input: WorksheetInput): Promise<{ rows: WorksheetRow[]; warnings: string[] }> {
	const spec = input.spec ?? "";
	const codeContext = input.codeContext ?? "";
	const rows: WorksheetRow[] = [];
	const warnings: string[] = [];
	for (const batch of chunk(input.cases, WORKSHEET_BATCH_SIZE)) {
		let reply: Record<string, unknown> | null;
		try {
			reply = extractJsonObject(
				await input.model.complete([
					{ role: "system", content: SYSTEM },
					{ role: "user", content: userPrompt(batch, spec, codeContext) },
				]),
			);
		} catch (err) {
			const message = `model call failed: ${(err as Error).message}`;
			warnings.push(message);
			for (const tc of batch) rows.push(reviewRow(tc, [], "", [message]));
			continue;
		}
		const answered = Array.isArray(reply?.cases) ? (reply.cases as unknown[]) : null;
		if (!answered) warnings.push("model reply had no `cases` array; batch held for review");
		const byKey = new Map<string, Record<string, unknown>>();
		for (const item of answered ?? []) {
			if (item && typeof item === "object") {
				const entry = item as Record<string, unknown>;
				if (!byKey.has(String(entry.key))) byKey.set(String(entry.key), entry);
			}
		}
		batch.forEach((tc, i) => {
			const entry = byKey.get(String(i));
			if (!entry) {
				rows.push(reviewRow(tc, [], "", ["모델 응답에 이 케이스의 해석이 없음"]));
				return;
			}
			const proposed: ProposedStep[] = Array.isArray(entry.steps)
				? (entry.steps as unknown[]).map((s) =>
						s && typeof s === "object" ? (s as ProposedStep) : { source: null, step: s },
					)
				: [];
			const proposedSteps = proposed.map((p) => (typeof p.step === "string" ? p.step.trim() : String(p.step)));
			const evidence = typeof entry.evidence === "string" ? entry.evidence.trim() : "";
			const reasons = validate(proposed, evidence, { tc, spec, codeContext });
			if (reasons.length > 0) rows.push(reviewRow(tc, proposedSteps, evidence, reasons));
			else rows.push({ ...baseRow(tc), steps: proposedSteps, status: "ok", evidence });
		});
	}
	return { rows, warnings };
}

/** The work sheet as a grid: header row + one row per case, multi-step cells joined by newlines. */
export function worksheetGrid(rows: readonly WorksheetRow[]): string[][] {
	return [
		[...WORKSHEET_HEADERS],
		...rows.map((r) => [
			r.sourceId,
			r.category,
			r.title,
			r.precondition,
			r.originalSteps.join("\n"),
			r.steps.join("\n"),
			r.expected,
			r.status,
			r.evidence,
		]),
	];
}

/** Write the work sheet as .xlsx (one tab, 작업시트) or .csv (UTF-8 with BOM). */
export function writeWorksheet(file: string, rows: readonly WorksheetRow[]): void {
	const extension = extname(file).toLowerCase();
	const grid = worksheetGrid(rows);
	if (extension === ".csv") {
		writeFileSync(file, `\uFEFF${toCsv(grid)}\n`, "utf8");
		return;
	}
	if (extension !== ".xlsx") throw new Error(`Unsupported output format: ${extension || file} (use .xlsx or .csv)`);
	const XLSX: typeof import("xlsx") = createRequire(import.meta.url)("xlsx");
	// A workbook tab name becomes the category prefix on read-back; naming the tab after the one category every
	// row shares keeps that category exactly as it was in the source.
	const categories = [...new Set(rows.map((r) => r.category))];
	const only = categories.length === 1 ? (categories[0] ?? "") : "";
	const tab = only && only.length <= 31 && !/[[\]:*?/\\]/.test(only) ? only : "작업시트";
	const book = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(grid), tab);
	XLSX.writeFile(book, file, { bookType: "xlsx" });
}
