/**
 * Generate a QC sheet from a 기획서 (spec document) when no QC exists yet.
 *
 * The model drafts the cases; everything after its answer is deterministic: strict JSON parsing, every
 * step checked against the canonical grammar *and* against `parseStep` under the same rule a run uses,
 * one re-ask listing the steps that failed, then dedupe. A case whose steps still do not parse is kept
 * and flagged (warnings + 비고) — dropping it would silently shrink coverage, which is worse than a case
 * a human has to fix.
 */
import { createRequire } from "node:module";
import { toCsv } from "../intake/csv.ts";
import type { ModelClient, ModelMessage } from "../model/model-client.ts";
import { parseStep } from "./interpret.ts";
import { establishRuleFromHeaders, extractJsonObject } from "./rule.ts";

const XLSX: typeof import("xlsx") = createRequire(import.meta.url)("xlsx");

export interface GeneratedCase {
	id: string;
	category: string;
	title: string;
	precondition: string;
	steps: string[];
	expected: string;
	priority: string;
	/** The requirement(s) the case verifies, as cited in the spec ("FR-2"). */
	sourceRef: string;
	/** 비고: why this case is not ready for automation; absent when it is. */
	note?: string;
}

export interface RequirementCoverage {
	requirement: string;
	cases: string[];
}

export interface GenerateQcResult {
	cases: GeneratedCase[];
	warnings: string[];
	/** One entry per requirement id found in the spec, in spec order. */
	coverage: RequirementCoverage[];
}

export interface GenerateQcInput {
	spec: string;
	specName: string;
	codeContext?: string;
	model: ModelClient;
	language?: "ko" | "en";
}

/** The headers the generated cases are validated under — the shape the QC fixtures use. */
export const INGEST_HEADERS = ["번호", "대분류", "시험항목", "사전조건", "시험절차", "예상결과", "우선순위"];
/** Output headers: the ingest headers plus the requirement citation and the flag column. */
export const QC_HEADERS = [...INGEST_HEADERS, "근거", "비고"];

const RULE = establishRuleFromHeaders(INGEST_HEADERS);

/** Each canonical form and the action `parseStep` must read it as; anything else is not automatable. */
const GRAMMAR: { re: RegExp; kind: string }[] = [
	{ re: /^open (\/\S*|https?:\/\/\S+)$/, kind: "goto" },
	{ re: /^enter "[^"]*" into "[^"]+"$/, kind: "fill" },
	{ re: /^click "[^"]+"$/, kind: "click" },
	{ re: /^verify page shows "[^"]+"$/, kind: "verify" },
];

/** Why a step is not automatable, or null when it is canonical and the engine reads it as written. */
export function stepProblem(step: string): string | null {
	const form = GRAMMAR.find((g) => g.re.test(step));
	if (!form) return "not in the canonical grammar";
	const kind = parseStep(step, RULE).kind;
	if (kind !== form.kind) return `the engine reads it as "${kind}", not "${form.kind}"`;
	return null;
}

const MAX_CODE_CONTEXT = 12_000;

function systemPrompt(language: "ko" | "en"): string {
	const prose = language === "ko" ? "Korean" : "English";
	const priorities = language === "ko" ? '"상", "중" or "하"' : '"High", "Medium" or "Low"';
	return [
		"You are a senior QA engineer. From a product specification (기획서) you write the QC sheet (test cases) a",
		"deterministic browser engine will execute. Rules:",
		"1. Cover EVERY functional requirement with at least one positive case, plus the meaningful negative and",
		'   boundary cases. sourceRef cites the requirement id(s) the case verifies exactly as the spec writes them ("FR-2";',
		'   several as "FR-2, FR-3"). If the spec has no ids, cite the section heading.',
		"2. steps is an array of strings. Every step is EXACTLY one of these four forms, nothing else:",
		"     open <path>                     (an app path starting with /)",
		'     enter "<value>" into "<label>"',
		'     click "<label>"',
		'     verify page shows "<text>"',
		"   No numbering, no extra words, no other verbs, no double quotes inside a value. A step is always English even",
		"   when the rest of the sheet is not. <label> is the control's visible label, placeholder or button text exactly",
		"   as written in the spec or code context. Use only routes and labels that exist in the spec or code context.",
		"3. Every case starts with an open step so it is self-contained. precondition is an empty string whenever the",
		"   steps establish the state themselves; write one only for a state the steps cannot create (that case will",
		"   need manual setup).",
		"4. expected is the observable result: the exact UI copy the page shows after the steps, copied verbatim from",
		"   the spec — just that text, no surrounding prose and no quotes. The last step verifies the same text with",
		'   verify page shows "<text>". Prefer copy that distinguishes the correct behaviour from a wrong one.',
		"5. Never invent UI copy, routes or features that are not in the spec or code context; skip out-of-scope items.",
		`6. title, category and precondition are written in ${prose}. priority is ${priorities}.`,
		'Respond ONLY with JSON: {"cases":[{"id":"TC-001","category":"","title":"","precondition":"","steps":["open /"],',
		'"expected":"","priority":"","sourceRef":"FR-1"}]}',
	].join("\n");
}

function userPrompt(input: GenerateQcInput): string {
	const parts = [`SPEC (${input.specName}):\n${input.spec.trim()}`];
	const code = input.codeContext?.trim();
	if (code)
		parts.push(`CODE CONTEXT (routes, files, components from the repository):\n${code.slice(0, MAX_CODE_CONTEXT)}`);
	return parts.join("\n\n");
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function toSteps(value: unknown): string[] {
	const raw = Array.isArray(value) ? value.map(text) : text(value).split("\n");
	// A model that numbers its steps anyway is saying the same thing; the number is not part of the grammar.
	return raw.map((s) => s.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean);
}

function sanitizeCase(raw: unknown): GeneratedCase | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const c: GeneratedCase = {
		id: text(r.id),
		category: text(r.category),
		title: text(r.title),
		precondition: text(r.precondition),
		steps: toSteps(r.steps),
		expected: text(r.expected),
		priority: text(r.priority),
		sourceRef: text(r.sourceRef),
	};
	return c.title || c.steps.length > 0 || c.expected ? c : null;
}

function parseCases(reply: string): GeneratedCase[] | null {
	const obj = extractJsonObject(reply);
	if (!obj || !Array.isArray(obj.cases)) return null;
	return obj.cases.map(sanitizeCase).filter((c): c is GeneratedCase => c !== null);
}

function stepProblems(c: GeneratedCase): string[] {
	const out: string[] = [];
	if (c.steps.length === 0) out.push("no steps");
	c.steps.forEach((step, i) => {
		const problem = stepProblem(step);
		if (problem) out.push(`step ${i + 1} \`${step}\`: ${problem}`);
	});
	return out;
}

/** Requirement ids the spec defines ("FR-1", "NFR-2", "REQ-3"), in order of first appearance. */
export function specRequirements(spec: string): string[] {
	return [...new Set([...spec.matchAll(/\b(?:FR|NFR|REQ|SR|UR|US)-\d+(?:\.\d+)*\b/g)].map((m) => m[0]))];
}

function refsOf(c: GeneratedCase): string[] {
	return c.sourceRef
		.split(/[,;/\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

export async function generateQc(input: GenerateQcInput): Promise<GenerateQcResult> {
	const language = input.language ?? "ko";
	const messages: ModelMessage[] = [
		{ role: "system", content: systemPrompt(language) },
		{ role: "user", content: userPrompt(input) },
	];
	const opts = { defaultEffort: "medium", timeoutMs: 240_000 };
	const first = await input.model.complete(messages, opts);
	const drafted = parseCases(first);
	if (!drafted) {
		throw new Error(
			`model returned malformed JSON (expected {"cases":[...]}): ${first.trim().slice(0, 200) || "<empty reply>"}`,
		);
	}
	if (drafted.length === 0) throw new Error("model returned no cases");
	const warnings: string[] = [];

	// Ids must be unique: the sheet's 번호 is how ingest keeps cases apart.
	const seen = new Set<string>();
	let cases = drafted.map((c, i) => {
		let id = c.id || `TC-${String(i + 1).padStart(3, "0")}`;
		while (seen.has(id)) id = `${id}-${i + 1}`;
		seen.add(id);
		return { ...c, id };
	});

	const broken = cases.filter((c) => stepProblems(c).length > 0);
	if (broken.length > 0) {
		const listing = broken.flatMap((c) => stepProblems(c).map((p) => `- ${c.id} ${p}`)).join("\n");
		const reask =
			`These steps cannot be automated:\n${listing}\n\nRewrite ONLY those cases (${broken.map((c) => c.id).join(", ")}) so ` +
			"every step is exactly one of the four canonical forms, keeping their ids, intent and sourceRef. If a step " +
			"cannot be expressed in the grammar, drop that step rather than paraphrase it. Respond ONLY with JSON " +
			'{"cases":[...]}.';
		const second = await input.model.complete(
			[...messages, { role: "assistant", content: first }, { role: "user", content: reask }],
			opts,
		);
		const fixed = parseCases(second);
		if (!fixed) {
			warnings.push(`re-ask for ${broken.length} case(s) returned malformed JSON; their original steps are kept`);
		} else {
			const byId = new Map(fixed.map((c) => [c.id, c]));
			cases = cases.map((c) => {
				const f = byId.get(c.id);
				return f && broken.some((b) => b.id === c.id) ? { ...f, id: c.id, sourceRef: f.sourceRef || c.sourceRef } : c;
			});
		}
	}

	cases = cases.map((c) => {
		const problems = stepProblems(c);
		if (!c.expected) problems.push("no expected result");
		if (problems.length === 0) return c;
		warnings.push(`${c.id} not automatable as written — ${problems.join("; ")}`);
		return { ...c, note: `자동화 불가 — ${problems.join("; ")}` };
	});

	const byContent = new Map<string, string>();
	cases = cases.filter((c) => {
		const key = JSON.stringify([c.title, c.precondition, c.steps, c.expected]);
		const earlier = byContent.get(key);
		if (earlier) {
			warnings.push(`${c.id} removed: same content as ${earlier}`);
			return false;
		}
		byContent.set(key, c.id);
		return true;
	});

	const requirements = specRequirements(input.spec);
	const coverage = requirements.map((requirement) => ({
		requirement,
		cases: cases.filter((c) => refsOf(c).includes(requirement)).map((c) => c.id),
	}));
	for (const cov of coverage) {
		if (cov.cases.length === 0) warnings.push(`${cov.requirement} has no case`);
	}
	for (const c of cases) {
		if (!c.sourceRef) warnings.push(`${c.id} cites no requirement`);
		const unknown = requirements.length ? refsOf(c).filter((r) => /-\d/.test(r) && !requirements.includes(r)) : [];
		if (unknown.length) warnings.push(`${c.id} cites ${unknown.join(", ")}, which the spec does not define`);
	}
	return { cases, warnings, coverage };
}

function caseRow(c: GeneratedCase): string[] {
	return [
		c.id,
		c.category,
		c.title,
		c.precondition,
		c.steps.join("\n"),
		c.expected,
		c.priority,
		c.sourceRef,
		c.note ?? "",
	];
}

/** The cases as CSV under `QC_HEADERS`, with a UTF-8 BOM so Excel opens the Korean headers correctly. */
export function toQcCsv(cases: readonly GeneratedCase[]): string {
	return `\uFEFF${toCsv([QC_HEADERS, ...cases.map(caseRow)])}`;
}

export interface QcWorkbookMeta {
	specName: string;
	date: string;
	modelLabel: string;
}

/** A workbook shaped like the QC a team hands over: a 표지 cover tab, then the cases on a QC tab. */
export function toQcWorkbook(cases: readonly GeneratedCase[], meta: QcWorkbookMeta): Uint8Array {
	const book = XLSX.utils.book_new();
	const cover = [
		["기획서", meta.specName],
		["생성일", meta.date],
		["모델", meta.modelLabel],
		["케이스 수", String(cases.length)],
	];
	XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(cover), "표지");
	XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([QC_HEADERS, ...cases.map(caseRow)]), "QC");
	return new Uint8Array(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
}
