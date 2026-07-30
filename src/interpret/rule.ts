/**
 * Interpretation rule: how to read a sheet (column mapping + intent keywords +
 * destructive markers). Versioned + persisted so it is reused across runs and
 * so bumping `ruleVersion` invalidates downstream assertion caches. A deterministic
 * baseline is derived from headers; `refineRule` conversationally refines it via a
 * `ModelClient` (the AI "rule establishment" seam).
 */

import { readFileSync, writeFileSync } from "node:fs";

import { mapColumns } from "../intake/ingest.ts";
import type { TcField } from "../intake/schema.ts";
import type { ModelClient, ModelMessage } from "../model/model-client.ts";
import type { CharClass } from "./assertion.ts";
import type { RouteEntry } from "./recon.ts";

export const INTENT_KINDS = ["navigate", "click", "input", "verify", "wait"] as const;
export type IntentKind = (typeof INTENT_KINDS)[number];

export interface InterpretationRule {
	ruleId: string;
	ruleVersion: number;
	mapping: Partial<Record<TcField, string>>;
	intents: Record<IntentKind, string[]>;
	destructiveKeywords: string[];
	/** Author-provided free-text domain context/instructions fed to AI plan authoring (per sheet). */
	appContext?: string;
	/** Author-provided free-text code/repo context fed to AI plan authoring (per sheet). */
	codeContext?: string;
	/**
	 * The app's label→route table as recon observed it. Structured, not prose: it is read by code that
	 * derives a url assertion for a navigation expectation, which a paragraph cannot support.
	 */
	routes?: RouteEntry[];
	/**
	 * Vocabulary the *judgement* side reads, alongside `intents` for the action side.
	 *
	 * These phrases used to be regex literals in `interpret.ts` and `author.ts`, which split one concern
	 * across two homes: a sheet could teach the engine new words for "click" but not for "must be
	 * restricted". Worse, two of them had no English at all — `12자 초과`, `특수문자` — so an English sheet
	 * silently derived nothing, which is the kind of failure that surfaces last.
	 */
	phrases: Record<PhraseKind, string[]>;
	/**
	 * Words naming a character class an input is expected to refuse ("특수문자", "uppercase"). Structured
	 * per class because each maps to a different check, not to a different phrasing of one check.
	 */
	charClasses: Record<CharClass, string[]>;
}

/**
 * `prose` marks a written requirement rather than page text; `navigation` and `restriction` mark what an
 * expected result claims; `uiNoun` is the trailing noun to strip from a target label; `lengthUnit` and
 * `exceed` combine to read a limit ("12자 초과", "over 12 characters") without storing a regex on disk.
 */
export type PhraseKind = "prose" | "navigation" | "restriction" | "uiNoun" | "lengthUnit" | "exceed";

/**
 * Default intent vocabulary. Korean terms are first-class, not an add-on: the sheets this tool
 * exists for are written in Korean ("1. 개인정보처리방침 선택"), and an English-only vocabulary
 * classifies every one of their steps as uninterpretable — a whole run that executes nothing.
 */
const DEFAULT_INTENTS: Record<IntentKind, string[]> = {
	navigate: ["navigate", "go to", "open", "visit", "이동", "진입", "접속", "열기", "들어가"],
	click: ["click", "press", "tap", "select", "선택", "클릭", "누르", "터치", "탭"],
	input: ["enter", "type", "fill", "input", "입력", "기입", "작성", "타이핑"],
	verify: ["verify", "expect", "should", "assert", "see", "shows", "확인", "검증", "표출", "노출", "표시"],
	wait: ["wait", "until", "pause", "대기", "기다"],
};

const DEFAULT_DESTRUCTIVE = ["delete", "remove", "drop", "purge", "wipe", "reset", "destroy"];

/**
 * Defaults are exactly the literals these phrases replaced, so no existing sheet changes behaviour —
 * and English is now present in every list, including the two that had none.
 */
export const DEFAULT_PHRASES: Record<PhraseKind, string[]> = {
	prose: ["되어야", "해야", "하여야", "한다.", "합니다.", "바랍니다", "should", "must"],
	navigation: ["이동", "전환", "redirect", "navigat", "moves to", "move to"],
	restriction: [
		"입력 제한",
		"입력제한",
		"제한되어야",
		"입력되지 않아야",
		"허용되지 않아야",
		"막혀야",
		"입력 불가",
		"must not accept",
		"must be rejected",
		"not allowed",
	],
	uiNoun: [
		"버튼",
		"링크",
		"메뉴",
		"탭",
		"아이콘",
		"영역",
		"필드",
		"입력란",
		"체크박스",
		"button",
		"link",
		"menu",
		"tab",
		"icon",
		"field",
		"checkbox",
	],
	lengthUnit: ["자", "글자", "characters", "chars", "letters"],
	exceed: ["초과", "이상", "넘게", "over", "more than", "exceeding", "longer than"],
};

/** Each class's names, in both languages. `nonDigit` is "anything but digits", i.e. 숫자 외. */
export const DEFAULT_CHAR_CLASSES: Record<CharClass, string[]> = {
	hangul: ["한글", "hangul", "korean"],
	upper: ["영문 대문자", "영문대문자", "대문자", "uppercase", "capital"],
	symbol: ["특수문자", "특수 문자", "기호", "special character", "symbol", "punctuation"],
	nonDigit: ["숫자 외", "숫자외", "비숫자", "non-digit", "non digit", "not a number"],
};

/** Deterministic baseline rule derived from a sheet's headers. */
export function establishRuleFromHeaders(headers: string[], ruleId = "default"): InterpretationRule {
	return {
		ruleId,
		ruleVersion: 1,
		mapping: mapColumns(headers),
		intents: structuredClone(DEFAULT_INTENTS),
		destructiveKeywords: [...DEFAULT_DESTRUCTIVE],
		phrases: structuredClone(DEFAULT_PHRASES),
		charClasses: structuredClone(DEFAULT_CHAR_CLASSES),
	};
}

/** Increment the version. Downstream assertion caches keyed by ruleVersion invalidate on change. */
export function bumpRuleVersion(rule: InterpretationRule): InterpretationRule {
	return { ...rule, ruleVersion: rule.ruleVersion + 1 };
}

export function serializeRule(rule: InterpretationRule): string {
	return `${JSON.stringify(rule, null, 2)}\n`;
}

export function parseRule(text: string): InterpretationRule {
	const raw = JSON.parse(text) as Partial<InterpretationRule>;
	if (typeof raw.ruleId !== "string" || typeof raw.ruleVersion !== "number") {
		throw new Error("invalid rule: missing ruleId/ruleVersion");
	}
	return {
		ruleId: raw.ruleId,
		ruleVersion: raw.ruleVersion,
		mapping: sanitizeMapping((raw as Record<string, unknown>).mapping, {}),
		intents: sanitizeIntents((raw as Record<string, unknown>).intents, DEFAULT_INTENTS),
		destructiveKeywords: sanitizeStrings((raw as Record<string, unknown>).destructiveKeywords, DEFAULT_DESTRUCTIVE),
		appContext: typeof raw.appContext === "string" ? raw.appContext : undefined,
		codeContext: typeof raw.codeContext === "string" ? raw.codeContext : undefined,
		routes: sanitizeRoutes((raw as Record<string, unknown>).routes),
		phrases: sanitizeKeyed((raw as Record<string, unknown>).phrases, DEFAULT_PHRASES),
		charClasses: sanitizeKeyed((raw as Record<string, unknown>).charClasses, DEFAULT_CHAR_CLASSES),
	};
}

/**
 * Routes come off disk, so they are untrusted: keep only entries that are really a label and an
 * app-internal path.
 *
 * `parseRule` rebuilds the rule field by field instead of spreading it, which is deliberate — but it
 * also means a newly added field is silently dropped until it is listed there. `routes` was: recon
 * wrote six of them, the state file held them, and the next server start parsed them away. Everything
 * downstream then behaved as if app analysis had never run, and a full measurement was spent on it —
 * 58 preparations failing on clicks the route table would have replaced with a goto.
 */
function sanitizeRoutes(raw: unknown): RouteEntry[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: RouteEntry[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const { label, path } = item as Record<string, unknown>;
		if (typeof label !== "string" || typeof path !== "string") continue;
		if (!label.trim() || !path.startsWith("/")) continue;
		out.push({ label: label.trim(), path });
	}
	return out.length > 0 ? out : undefined;
}

export function saveRule(path: string, rule: InterpretationRule): void {
	writeFileSync(path, serializeRule(rule), "utf8");
}

export function loadRule(path: string): InterpretationRule {
	return parseRule(readFileSync(path, "utf8"));
}

export interface RuleRefineResult {
	rule: InterpretationRule;
	message: string;
	changed: boolean;
}

/** Conversationally refine a rule from a natural-language instruction via the model seam. */
export async function refineRule(
	rule: InterpretationRule,
	instruction: string,
	model: ModelClient,
	history: ModelMessage[] = [],
): Promise<RuleRefineResult> {
	const system =
		"You collaboratively refine a spreadsheet-interpretation rule across a conversation. Fields: mapping " +
		"(tc field -> EXACT header; fields id,title,step,expected,priority,role,env), intents " +
		"(navigate|click|input|verify|wait -> trigger phrases), destructiveKeywords (words marking a destructive step). " +
		"Keep the rule minimal and interpretable: a trigger phrase must belong to only ONE intent, avoid redundant " +
		'phrases, prefer few clear ones. Respond ONLY JSON {"mapping":{...},"intents":{...},"destructiveKeywords":[...],' +
		'"message":"1-2 sentence explanation of what changed and why"}. Preserve unchanged parts.';
	const user = `CURRENT RULE: ${JSON.stringify({
		mapping: rule.mapping,
		intents: rule.intents,
		destructiveKeywords: rule.destructiveKeywords,
	})}\nINSTRUCTION: ${instruction}`;
	const obj =
		extractJsonObject(
			await model.complete([{ role: "system", content: system }, ...history, { role: "user", content: user }]),
		) ?? {};
	const next: InterpretationRule = {
		ruleId: rule.ruleId,
		ruleVersion: rule.ruleVersion,
		mapping: sanitizeMapping(obj.mapping, rule.mapping),
		intents: sanitizeIntents(obj.intents, rule.intents),
		destructiveKeywords: sanitizeStrings(obj.destructiveKeywords, rule.destructiveKeywords),
		appContext: rule.appContext,
		codeContext: rule.codeContext,
		routes: rule.routes,
		phrases: sanitizeKeyed(obj.phrases, rule.phrases),
		charClasses: sanitizeKeyed(obj.charClasses, rule.charClasses),
	};
	const changed = ruleShapeKey(next) !== ruleShapeKey(rule);
	return { rule: changed ? bumpRuleVersion(next) : next, message: String(obj.message ?? ""), changed };
}

/** Set the author-provided AI context; bumps the version so cached plans re-author on the next run. */
export function setRuleContext(rule: InterpretationRule, appContext: string): InterpretationRule {
	const next = appContext.trim();
	if (next === (rule.appContext ?? "").trim()) return rule;
	return { ...rule, appContext: next || undefined, ruleVersion: rule.ruleVersion + 1 };
}

/** Set the author-provided code/repo context; bumps the version so cached plans re-author on the next run. */
export function setRuleCodeContext(rule: InterpretationRule, codeContext: string): InterpretationRule {
	const next = codeContext.trim();
	if (next === (rule.codeContext ?? "").trim()) return rule;
	return { ...rule, codeContext: next || undefined, ruleVersion: rule.ruleVersion + 1 };
}

/** Set the observed route table; bumps the version so cached plans re-author against it. */
export function setRuleRoutes(rule: InterpretationRule, routes: readonly RouteEntry[]): InterpretationRule {
	const next = routes.map((r) => ({ label: r.label, path: r.path }));
	const same =
		next.length === (rule.routes?.length ?? 0) &&
		next.every((r, i) => r.label === rule.routes?.[i]?.label && r.path === rule.routes?.[i]?.path);
	if (same) return rule;
	return { ...rule, routes: next.length ? next : undefined, ruleVersion: rule.ruleVersion + 1 };
}

/** Human-readable warnings that keep a rule interpretable: ambiguous or empty intents. */
export function ruleLint(rule: InterpretationRule): string[] {
	const warnings: string[] = [];
	const owners = new Map<string, IntentKind[]>();
	for (const kind of INTENT_KINDS) {
		if (rule.intents[kind].length === 0) warnings.push(`intent "${kind}" has no trigger phrases`);
		for (const phrase of rule.intents[kind]) {
			const key = phrase.toLowerCase().trim();
			if (!key) continue;
			owners.set(key, [...(owners.get(key) ?? []), kind]);
		}
	}
	for (const [phrase, kinds] of owners) {
		if (kinds.length > 1) warnings.push(`"${phrase}" is ambiguous — matches ${kinds.join(", ")} (first match wins)`);
	}
	return warnings;
}

function ruleShapeKey(rule: InterpretationRule): string {
	return JSON.stringify({ m: rule.mapping, i: rule.intents, d: rule.destructiveKeywords });
}

const TC_FIELDS: TcField[] = ["id", "title", "step", "expected", "priority", "role", "env"];

function sanitizeMapping(value: unknown, fallback: Partial<Record<TcField, string>>): Partial<Record<TcField, string>> {
	if (!value || typeof value !== "object") return { ...fallback };
	const raw = value as Record<string, unknown>;
	const out: Partial<Record<TcField, string>> = {};
	for (const f of TC_FIELDS) {
		const v = raw[f];
		if (typeof v === "string" && v.length > 0) out[f] = v;
		else if (fallback[f]) out[f] = fallback[f];
	}
	return out;
}

function sanitizeIntents(value: unknown, fallback: Record<IntentKind, string[]>): Record<IntentKind, string[]> {
	return sanitizeKeyed(value, fallback);
}

/**
 * Keep a keyed set of phrase lists, falling back per key. Untrusted input: a rule arrives off disk or
 * out of a model, so a missing or malformed key must leave the default in place rather than empty the
 * vocabulary — an empty list silently stops matching anything, which is invisible in the verdicts.
 */
function sanitizeKeyed<K extends string>(value: unknown, fallback: Record<K, string[]>): Record<K, string[]> {
	const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
	const out = {} as Record<K, string[]>;
	for (const k of Object.keys(fallback) as K[]) {
		const v = raw[k];
		const kept = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
		out[k] = kept.length > 0 ? kept : [...fallback[k]];
	}
	return out;
}

function sanitizeStrings(value: unknown, fallback: string[]): string[] {
	return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [...fallback];
}

export function extractJsonObject(text: string): Record<string, unknown> | null {
	const t = text.trim();
	try {
		const o = JSON.parse(t);
		return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
	} catch {
		const start = t.indexOf("{");
		const end = t.lastIndexOf("}");
		if (start !== -1 && end > start) {
			try {
				const o = JSON.parse(t.slice(start, end + 1));
				return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
			} catch {
				return null;
			}
		}
		return null;
	}
}
