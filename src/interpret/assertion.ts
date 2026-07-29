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

/**
 * What a text assertion is allowed to see: the page's visible text plus the current value of every
 * form field. A value someone typed is on screen for a human but absent from the DOM's text, so
 * without the fields an "입력 제한" case can never fail — the typed string is nowhere to be found
 * whether the app rejected it or not.
 */
function haystack(snap: PageSnapshot): string {
	const values = Object.values(snap.fields ?? {}).filter(Boolean);
	return values.length ? `${snap.text}\n${values.join("\n")}` : snap.text;
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
			const inText = has(snap.text, a.value);
			const passed = inText || has(haystack(snap), a.value);
			// Naming the field match keeps a reviewer from hunting the page for text that is in a box.
			const where = inText ? "text" : "field value";
			return { assertion: a, passed, detail: passed ? `${where} has "${a.value}"` : `text lacks "${a.value}"` };
		}
		case "textNotIncludes": {
			const inText = has(snap.text, a.value);
			const inField = !inText && has(haystack(snap), a.value);
			const passed = !inText && !inField;
			return {
				assertion: a,
				passed,
				detail: passed ? `text lacks "${a.value}"` : `${inText ? "text" : "field value"} unexpectedly has "${a.value}"`,
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

/**
 * Bump when the authoring contract changes — the prompt, the sanitizer, anything that would make the
 * same case produce a different plan today than it did before.
 *
 * The cache key covered the *inputs* (case, rule, rule version) but not the code that turned them
 * into a plan, so improving authoring never reached a sheet that had already run. Yesterday's prose
 * filter only landed because plans are re-sanitized on read; a prompt change has no such escape
 * hatch. Making it part of the key is what lets authoring be fixed at all.
 */
export const AUTHOR_VERSION = 3;

/** Cache key: any change to the case, the rule, or the authoring contract forces a miss -> re-author. */
export function assertionCacheKey(caseId: string, ruleId: string, ruleVersion: number, caseHash: string): string {
	return `${caseId}|${ruleId}|v${ruleVersion}|a${AUTHOR_VERSION}|${caseHash}`;
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
