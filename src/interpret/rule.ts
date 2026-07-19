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
import type { ModelClient } from "../model/model-client.ts";

export const INTENT_KINDS = ["navigate", "click", "input", "verify", "wait"] as const;
export type IntentKind = (typeof INTENT_KINDS)[number];

export interface InterpretationRule {
	ruleId: string;
	ruleVersion: number;
	mapping: Partial<Record<TcField, string>>;
	intents: Record<IntentKind, string[]>;
	destructiveKeywords: string[];
}

const DEFAULT_INTENTS: Record<IntentKind, string[]> = {
	navigate: ["navigate", "go to", "open", "visit"],
	click: ["click", "press", "tap", "select"],
	input: ["enter", "type", "fill", "input"],
	verify: ["verify", "expect", "should", "assert", "see", "shows"],
	wait: ["wait", "until", "pause"],
};

const DEFAULT_DESTRUCTIVE = ["delete", "remove", "drop", "purge", "wipe", "reset", "destroy"];

/** Deterministic baseline rule derived from a sheet's headers. */
export function establishRuleFromHeaders(headers: string[], ruleId = "default"): InterpretationRule {
	return {
		ruleId,
		ruleVersion: 1,
		mapping: mapColumns(headers),
		intents: structuredClone(DEFAULT_INTENTS),
		destructiveKeywords: [...DEFAULT_DESTRUCTIVE],
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
	};
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
): Promise<RuleRefineResult> {
	const system =
		"You refine a spreadsheet-interpretation rule. Fields: mapping (tc field -> EXACT header; fields " +
		"id,title,step,expected,priority,role,env), intents (navigate|click|input|verify|wait -> trigger phrases), " +
		'destructiveKeywords (words marking a destructive step). Respond ONLY JSON {"mapping":{...},"intents":{...},' +
		'"destructiveKeywords":[...],"message":"1-2 sentence explanation"}. Preserve unchanged parts.';
	const user = `CURRENT RULE: ${JSON.stringify({
		mapping: rule.mapping,
		intents: rule.intents,
		destructiveKeywords: rule.destructiveKeywords,
	})}\nINSTRUCTION: ${instruction}`;
	const obj =
		extractJsonObject(
			await model.complete([
				{ role: "system", content: system },
				{ role: "user", content: user },
			]),
		) ?? {};
	const next: InterpretationRule = {
		ruleId: rule.ruleId,
		ruleVersion: rule.ruleVersion,
		mapping: sanitizeMapping(obj.mapping, rule.mapping),
		intents: sanitizeIntents(obj.intents, rule.intents),
		destructiveKeywords: sanitizeStrings(obj.destructiveKeywords, rule.destructiveKeywords),
	};
	const changed = ruleShapeKey(next) !== ruleShapeKey(rule);
	return { rule: changed ? bumpRuleVersion(next) : next, message: String(obj.message ?? ""), changed };
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
	const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
	const out = {} as Record<IntentKind, string[]>;
	for (const k of INTENT_KINDS) {
		const v = raw[k];
		out[k] = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [...fallback[k]];
	}
	return out;
}

function sanitizeStrings(value: unknown, fallback: string[]): string[] {
	return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [...fallback];
}

function extractJsonObject(text: string): Record<string, unknown> | null {
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
