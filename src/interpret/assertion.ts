/**
 * Deterministic assertions + an assertion cache. Assertions are authored once
 * (author-time, possibly by an LLM) and cached by (caseId, ruleId, ruleVersion,
 * caseHash); run-time verdict is a pure function of cached assertions over a page
 * snapshot — so re-runs are identical. Changing the rule version or the case
 * content changes the key and forces re-authoring (cache invalidation).
 */

import type { PageSnapshot } from "../execute/page.ts";

export type Assertion =
	| { kind: "urlIncludes"; value: string }
	| { kind: "textIncludes"; value: string }
	| { kind: "textNotIncludes"; value: string };

export interface AssertionResult {
	assertion: Assertion;
	passed: boolean;
	detail: string;
}

/** Collapse whitespace + drop light punctuation so a near-miss (a stray comma/space) still matches. */
function looseText(s: string): string {
	return s.replace(/\s+/g, "").replace(/[.,·・…–—\-!?~()[\]{}"'“”‘’`:;]/gu, "");
}

/** Pure, deterministic evaluation of one assertion against a snapshot. `lenient` ignores whitespace/punctuation. */
export function evaluateAssertion(a: Assertion, snap: PageSnapshot, opts: { lenient?: boolean } = {}): AssertionResult {
	const has = (hay: string, needle: string) =>
		opts.lenient ? looseText(hay).includes(looseText(needle)) : hay.includes(needle);
	switch (a.kind) {
		case "urlIncludes": {
			const passed = snap.url.includes(a.value);
			return { assertion: a, passed, detail: passed ? `url has "${a.value}"` : `url "${snap.url}" lacks "${a.value}"` };
		}
		case "textIncludes": {
			const passed = has(snap.text, a.value);
			return { assertion: a, passed, detail: passed ? `text has "${a.value}"` : `text lacks "${a.value}"` };
		}
		case "textNotIncludes": {
			const passed = !has(snap.text, a.value);
			return {
				assertion: a,
				passed,
				detail: passed ? `text lacks "${a.value}"` : `text unexpectedly has "${a.value}"`,
			};
		}
	}
}

export function dedupeAssertions(assertions: Assertion[]): Assertion[] {
	const seen = new Set<string>();
	const out: Assertion[] = [];
	for (const a of assertions) {
		const key = `${a.kind}:${a.value}`;
		if (!seen.has(key)) {
			seen.add(key);
			out.push(a);
		}
	}
	return out;
}

/** Cache key includes ruleVersion + caseHash: any change forces a miss -> re-author. */
export function assertionCacheKey(caseId: string, ruleId: string, ruleVersion: number, caseHash: string): string {
	return `${caseId}|${ruleId}|v${ruleVersion}|${caseHash}`;
}

export interface AssertionCache {
	get(key: string): Assertion[] | undefined;
	set(key: string, assertions: Assertion[]): void;
}

export class MemoryAssertionCache implements AssertionCache {
	private readonly store = new Map<string, Assertion[]>();

	get(key: string): Assertion[] | undefined {
		const v = this.store.get(key);
		return v ? v.map((a) => ({ ...a })) : undefined;
	}

	set(key: string, assertions: Assertion[]): void {
		this.store.set(
			key,
			assertions.map((a) => ({ ...a })),
		);
	}
}
