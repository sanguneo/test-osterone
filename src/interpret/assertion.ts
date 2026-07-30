/**
 * Deterministic assertions + an assertion cache. Assertions are authored once
 * (author-time, possibly by an LLM) and cached by (caseId, ruleId, ruleVersion,
 * caseHash); run-time verdict is a pure function of cached assertions over a page
 * snapshot — so re-runs are identical. Changing the rule version or the case
 * content changes the key and forces re-authoring (cache invalidation).
 */

import type { PageSnapshot } from "../execute/page.ts";
import { withoutUiNoun } from "./rule.ts";

/**
 * Character classes a field must not end up containing, named by what is forbidden.
 *
 * Sheets state an input limit by the *kind* of character typed — "한글/영문 대문자/특수문자 입력",
 * "숫자 외 텍스트 입력" — never by a literal, which is why no string check can express them.
 */
export type CharClass = "hangul" | "upper" | "symbol" | "nonDigit";

export type Assertion =
	| { kind: "urlIncludes"; value: string }
	| { kind: "textIncludes"; value: string }
	| { kind: "textNotIncludes"; value: string }
	/** The named field holds at most `max` characters — "12자 초과 입력 → 입력 제한되어야 한다". */
	| { kind: "fieldAtMost"; field: string; max: number }
	/** The named field holds none of these character classes — "특수문자 입력 → 입력 제한되어야 한다". */
	| { kind: "fieldExcludes"; field: string; classes: readonly CharClass[] }
	/**
	 * The named radio/checkbox is selected — "활성 라디오 버튼 선택되어야 한다".
	 *
	 * The state of a toggle is nowhere in the page's text, and its `value` attribute is the same
	 * whichever one is chosen, so this class of expectation could only ever be held for review.
	 */
	| { kind: "controlSelected"; control: string }
	/**
	 * The named field holds what the case typed into it — "텍스트 입력 → 해당란에 반영되어야 한다".
	 *
	 * The requirement is anaphoric: "해당란" is whatever field the *step* named, so there is no literal
	 * in the expectation to quote and a text assertion could only ever guess at one.
	 */
	| { kind: "fieldHolds"; field: string; value: string };

/**
 * The string-valued kinds — the only ones the model is allowed to author.
 *
 * Listed by name rather than by shape: a code-derived kind that happens to carry a `value` (like
 * `fieldHolds`) must not become authorable just because it has the same field name.
 */
export type ValueAssertion = Extract<Assertion, { kind: "urlIncludes" | "textIncludes" | "textNotIncludes" }>;

export interface AssertionResult {
	assertion: Assertion;
	passed: boolean;
	detail: string;
}

/**
 * One-line human description of what an assertion checks.
 *
 * Field assertions carry no `value`, and several call sites read `a.value` directly to build a review
 * note or a results row. This keeps those honest for every kind.
 */
export function describeAssertion(a: Assertion): string {
	switch (a.kind) {
		case "fieldAtMost":
			return `${a.field} ≤ ${a.max}자`;
		case "fieldExcludes":
			return `${a.field} 제외: ${a.classes.join(", ")}`;
		case "controlSelected":
			return `${a.control} 선택됨`;
		case "fieldHolds":
			return `${a.field}에 "${a.value}"`;
		default:
			return a.value;
	}
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
/** What each class matches. Named by what must be *absent* from the field. */
const CHAR_CLASS: Record<CharClass, RegExp> = {
	hangul: /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/u,
	upper: /[A-Z]/,
	symbol: /[!-/:-@[-`{-~]/,
	nonDigit: /[^0-9]/,
};

/**
 * Find an entry by the label the plan used, tolerating the spacing the app renders.
 *
 * Returns the live label too, so a reviewer reads the app's wording rather than the plan's. Absence is
 * meaningful: the snapshot carries every field and every toggle, including the empty and the unselected
 * ones, so "not found" means there is no such control — not that the app cleared or deselected it.
 *
 * Exact, then whitespace/punctuation-insensitive, then the same name minus a trailing UI noun — and
 * deliberately no looser than that. A stem match on "아이디 입력란" resolved to a *different* box whose
 * placeholder shares the noun, one the case had never typed into, and its emptiness read as a working
 * restriction: two cases whose recorded defect is "the limit does not work" passed that way. Not
 * finding it fails instead, which is the safe answer — if the case's target is not what the check is
 * looking at, the check has learned nothing.
 *
 * The noun strip is the same later candidate the click and fill rankings use, and it belongs here for
 * the same reason it belongs there. Measured on NO 222: the plan filled "소속 그룹 입력란" — which lands,
 * by stripping — and the derived check then asked the snapshot for that unstripped string and was told
 * "not on screen", failing a case the app had handled correctly.
 */
function lookupLabelled<T>(map: Record<string, T> | undefined, label: string): { label: string; value: T } | null {
	const entries = map ?? {};
	const hit = (want: string): { label: string; value: T } | null => {
		const direct = entries[want];
		if (direct !== undefined) return { label: want, value: direct };
		const loose = looseText(want);
		for (const [key, value] of Object.entries(entries)) {
			if (looseText(key) === loose) return { label: key, value };
		}
		return null;
	};
	const stripped = withoutUiNoun(label);
	return hit(label) ?? (stripped ? hit(stripped) : null);
}

/**
 * The length limit the named field's own control declares, or null when it declares none.
 *
 * Used by the verdict layer, not by the check: a `fieldAtMost` whose box declares `maxlength` at or
 * below the asserted limit cannot fail, because `fill` was never able to put more in. Measured on NO
 * 142 — the case typed 260 characters into a box that declares 255, the field held 255, the check said
 * the limit works, and the defect a human recorded for that exact box is that it does not.
 */
export function declaredFieldLimit(snap: PageSnapshot, field: string): number | null {
	return lookupLabelled(snap.fieldLimits, field)?.value ?? null;
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
		case "fieldAtMost": {
			const found = lookupLabelled(snap.fields, a.field);
			// Cannot see the field → cannot verify the limit. Passing here is exactly the unsound shortcut
			// that let "입력 제한되어야 한다" go green on two cases whose recorded defect is that the limit
			// does not work: if the typed value never landed anywhere, nothing was ever restricted.
			if (!found) return { assertion: a, passed: false, detail: `field "${a.field}" not on screen` };
			const length = [...found.value].length;
			const passed = length <= a.max;
			return {
				assertion: a,
				passed,
				detail: passed
					? `field "${found.label}" holds ${length} ≤ ${a.max} chars`
					: `field "${found.label}" holds ${length} chars, over the ${a.max} limit`,
			};
		}
		case "fieldExcludes": {
			const found = lookupLabelled(snap.fields, a.field);
			if (!found) return { assertion: a, passed: false, detail: `field "${a.field}" not on screen` };
			const violated = a.classes.filter((c) => CHAR_CLASS[c].test(found.value));
			const passed = violated.length === 0;
			return {
				assertion: a,
				passed,
				detail: passed
					? `field "${found.label}" excludes ${a.classes.join(", ")}`
					: `field "${found.label}" accepted ${violated.join(", ")}: "${found.value.slice(0, 24)}"`,
			};
		}
		case "controlSelected": {
			const found = lookupLabelled(snap.controls, a.control);
			// Cannot see the control → cannot verify the selection. Same reasoning as the field checks:
			// a case that says "활성 라디오 버튼 선택되어야 한다" learns nothing from a screen with no such
			// toggle on it, and calling that a pass is how a click that never landed goes green.
			if (!found) return { assertion: a, passed: false, detail: `control "${a.control}" not on screen` };
			return {
				assertion: a,
				passed: found.value,
				detail: found.value ? `control "${found.label}" is selected` : `control "${found.label}" is not selected`,
			};
		}
		case "fieldHolds": {
			const found = lookupLabelled(snap.fields, a.field);
			if (!found) return { assertion: a, passed: false, detail: `field "${a.field}" not on screen` };
			// Punctuation-insensitive on purpose, and only here: an app that reflects "01012345678" as
			// "010-1234-5678" *did* reflect it, and separators it adds itself are not a rejection. The
			// check still fails on an empty box, a truncated value, or anything else — which is the whole
			// class of defect "해당란에 반영되어야 한다" is written to catch.
			const passed = looseText(found.value).includes(looseText(a.value));
			return {
				assertion: a,
				passed,
				detail: passed
					? `field "${found.label}" holds "${a.value.slice(0, 24)}"`
					: `field "${found.label}" holds "${found.value.slice(0, 24)}", not "${a.value.slice(0, 24)}"`,
			};
		}
	}
}

export function dedupeAssertions(assertions: Assertion[]): Assertion[] {
	const seen = new Set<string>();
	const out: Assertion[] = [];
	for (const a of assertions) {
		// A string kind is fully described by its value; every structured kind keys on its own shape, so
		// two checks about different fields are never collapsed into one just because they read alike.
		const key =
			a.kind === "urlIncludes" || a.kind === "textIncludes" || a.kind === "textNotIncludes"
				? `${a.kind}:${a.value}`
				: JSON.stringify(a);
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
export const AUTHOR_VERSION = 6;

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
