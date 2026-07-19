/**
 * Interpretation: turn NL steps into page actions, and author deterministic
 * assertions for a case under a rule. `getOrAuthorAssertions` reads/writes the
 * cache so assertions are authored once per (caseId, ruleId, ruleVersion, caseHash).
 */

import type { NormalizedTC } from "../intake/schema.ts";
import { type Assertion, type AssertionCache, assertionCacheKey, dedupeAssertions } from "./assertion.ts";
import type { InterpretationRule } from "./rule.ts";

export type PageAction =
	| { kind: "goto"; path: string }
	| { kind: "click"; target: string }
	| { kind: "fill"; target: string; value: string }
	| { kind: "verify"; text: string }
	| { kind: "unknown"; text: string };

function matchesIntent(step: string, keywords: string[]): boolean {
	const low = step.toLowerCase();
	return keywords.some((k) => low.includes(k));
}

function extractPath(step: string): string | null {
	return step.match(/(https?:\/\/\S+|\/[^\s"']*)/)?.[1] ?? null;
}

function extractQuoted(step: string): string[] {
	return [...step.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
}

/** Deterministic NL-step -> page action, using the rule's intent keywords. */
export function parseStep(step: string, rule: InterpretationRule): PageAction {
	if (matchesIntent(step, rule.intents.navigate)) {
		const path = extractPath(step);
		if (path) return { kind: "goto", path };
	}
	if (matchesIntent(step, rule.intents.input)) {
		const quoted = extractQuoted(step);
		if (quoted.length >= 2) return { kind: "fill", target: quoted[1] ?? "", value: quoted[0] ?? "" };
		if (quoted.length === 1) {
			const target = step
				.replace(/"[^"]*"/, "")
				.replace(/\b(enter|type|fill|input|into|in)\b/gi, "")
				.trim();
			return { kind: "fill", target, value: quoted[0] ?? "" };
		}
	}
	if (matchesIntent(step, rule.intents.click)) {
		const quoted = extractQuoted(step);
		const target = quoted[0] ?? step.replace(/\b(click|press|tap|select)\b/gi, "").trim();
		return { kind: "click", target };
	}
	if (matchesIntent(step, rule.intents.verify)) {
		return { kind: "verify", text: step };
	}
	return { kind: "unknown", text: step };
}

/** Deterministic baseline assertion authoring from a case + rule. */
export function authorAssertions(tc: NormalizedTC, rule: InterpretationRule): Assertion[] {
	const assertions: Assertion[] = [];
	for (const step of tc.steps) {
		if (parseStep(step, rule).kind === "verify") {
			for (const q of extractQuoted(step)) {
				if (q) assertions.push({ kind: "textIncludes", value: q });
			}
		}
	}
	if (tc.expected) assertions.push({ kind: "textIncludes", value: tc.expected });
	return dedupeAssertions(assertions);
}

export interface AuthoredAssertions {
	assertions: Assertion[];
	cacheHit: boolean;
	key: string;
}

/** Read cached assertions or author + cache them. Key encodes ruleVersion + caseHash. */
export function getOrAuthorAssertions(
	tc: NormalizedTC,
	rule: InterpretationRule,
	cache: AssertionCache,
): AuthoredAssertions {
	const key = assertionCacheKey(tc.caseId, rule.ruleId, rule.ruleVersion, tc.contentHash);
	const cached = cache.get(key);
	if (cached) return { assertions: cached, cacheHit: true, key };
	const assertions = authorAssertions(tc, rule);
	cache.set(key, assertions);
	return { assertions, cacheHit: false, key };
}
