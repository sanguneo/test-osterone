/**
 * AI authoring (author-time). Converts a case's free natural-language steps into a
 * deterministic execution plan (page actions + assertions) via the model — no quoted
 * DSL required. The plan is authored ONCE and cached by (caseId, ruleId, ruleVersion,
 * caseHash); run-time replays the cached plan deterministically, so the LLM never
 * judges a run and re-runs stay identical (false-pass = 0).
 */

import type { NormalizedTC } from "../intake/schema.ts";
import type { ModelClient } from "../model/model-client.ts";
import { type Assertion, assertionCacheKey } from "./assertion.ts";
import type { PageAction } from "./interpret.ts";
import { extractJsonObject, type InterpretationRule } from "./rule.ts";

export interface AuthoredPlan {
	actions: PageAction[];
	assertions: Assertion[];
}

export interface PlanCache {
	get(key: string): AuthoredPlan | undefined;
	set(key: string, plan: AuthoredPlan): void;
}

export class MemoryPlanCache implements PlanCache {
	private readonly store = new Map<string, AuthoredPlan>();
	get(key: string): AuthoredPlan | undefined {
		const v = this.store.get(key);
		return v ? structuredClone(v) : undefined;
	}
	set(key: string, plan: AuthoredPlan): void {
		this.store.set(key, structuredClone(plan));
	}
}

const ASSERTION_KINDS = new Set<Assertion["kind"]>(["urlIncludes", "textIncludes", "textNotIncludes"]);

/** Keep only well-formed goto/click/fill actions (drops anything the model got wrong). */
function sanitizeActions(raw: unknown): PageAction[] {
	if (!Array.isArray(raw)) return [];
	const out: PageAction[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const o = item as Record<string, unknown>;
		if (o.kind === "goto" && typeof o.path === "string" && o.path) out.push({ kind: "goto", path: o.path });
		else if (o.kind === "click" && typeof o.target === "string" && o.target)
			out.push({ kind: "click", target: o.target });
		else if (o.kind === "fill" && typeof o.target === "string" && typeof o.value === "string" && o.target)
			out.push({ kind: "fill", target: o.target, value: o.value });
	}
	return out;
}

/** Keep only well-formed, deduped assertions. */
function sanitizeAssertions(raw: unknown): Assertion[] {
	if (!Array.isArray(raw)) return [];
	const out: Assertion[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const o = item as Record<string, unknown>;
		const kind = o.kind as Assertion["kind"];
		if (ASSERTION_KINDS.has(kind) && typeof o.value === "string" && o.value) {
			const key = `${kind}:${o.value}`;
			if (!seen.has(key)) {
				seen.add(key);
				out.push({ kind, value: o.value });
			}
		}
	}
	return out;
}

/** Author a plan from natural-language steps via the model (author-time). */
export async function authorPlanAI(tc: NormalizedTC, model: ModelClient): Promise<AuthoredPlan> {
	const system =
		"You convert a web test case's natural-language steps into a deterministic browser execution plan. " +
		'Output ONLY JSON: {"actions":[...],"assertions":[...]}. actions items are ' +
		'{"kind":"goto","path":"/..."} | {"kind":"click","target":"<visible label/text/role name>"} | ' +
		'{"kind":"fill","target":"<field label>","value":"<text>"}. assertions items are ' +
		'{"kind":"textIncludes","value":"..."} | {"kind":"urlIncludes","value":"..."} | {"kind":"textNotIncludes","value":"..."}. ' +
		"Derive assertions from the Expected result and any verify/assert steps. Targets must be user-visible text, never CSS. Keep it minimal.";
	const user = `TITLE: ${tc.title}\nSTEPS:\n${tc.steps.map((s) => `- ${s}`).join("\n")}\nEXPECTED: ${tc.expected}`;
	const obj =
		extractJsonObject(
			await model.complete([
				{ role: "system", content: system },
				{ role: "user", content: user },
			]),
		) ?? {};
	return { actions: sanitizeActions(obj.actions), assertions: sanitizeAssertions(obj.assertions) };
}

export interface AuthoredPlanResult {
	plan: AuthoredPlan;
	cacheHit: boolean;
	key: string;
}

/** Read a cached plan or author + cache it (author-once per case + rule version). */
export async function getOrAuthorPlan(
	tc: NormalizedTC,
	rule: InterpretationRule,
	cache: PlanCache,
	model: ModelClient,
): Promise<AuthoredPlanResult> {
	const key = assertionCacheKey(tc.caseId, rule.ruleId, rule.ruleVersion, tc.contentHash);
	const cached = cache.get(key);
	if (cached) return { plan: cached, cacheHit: true, key };
	const plan = await authorPlanAI(tc, model);
	cache.set(key, plan);
	return { plan, cacheHit: false, key };
}
