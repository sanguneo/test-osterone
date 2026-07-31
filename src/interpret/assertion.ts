/**
 * Deterministic assertions + an assertion cache. Assertions are authored once
 * (author-time, possibly by an LLM) and cached by (caseId, ruleId, ruleVersion,
 * caseHash); run-time verdict is a pure function of cached assertions over a page
 * snapshot — so re-runs are identical. Changing the rule version or the case
 * content changes the key and forces re-authoring (cache invalidation).
 */

import type { PageSnapshot } from "../execute/page.ts";

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
 * Is this text a glyph rather than copy — no letter, digit, or hangul anywhere?
 *
 * A sheet quotes iconography as characters: "<<, <, 페이지번호, >, >> 버튼이 제공되어야 한다" names four
 * buttons the app paints as `<i class="icon">` with no text at all. A textIncludes on "<<" then fails
 * on every app that draws its arrows, working or not — the failure says nothing about the app. The
 * verdict layer softens a fail carried only by these to needs_review; a glyph check that *passes*
 * still counts, because then the text really is on screen.
 */
export function isIconographic(value: string): boolean {
	const v = value.trim();
	return v.length > 0 && !/[\p{L}\p{N}]/u.test(v);
}

/**
 * The empty field a click target operates on — the field's own name plus a verb ("<필드> 중복확인"),
 * with nothing ever typed into it.
 *
 * A control named after a box does that box's work: pressing "기관명 중복확인" asks the app to judge
 * whatever 기관명 holds. With the box empty there is nothing to judge, so whatever the screen does
 * next is not an answer to the case's question. Measured (NO 206): the precondition is "중복된 이름이
 * 없는 경우" — a *data* state, not a UI one — so the authored setup only opened the dialog, the case
 * pressed the button against an empty box, and the app's confirmation understandably never appeared.
 * A human running the same case types a name first.
 *
 * Deliberately not "fill something in": inventing the value a case never gave is how a check starts
 * answering for data the sheet never described. The engine can only say the state was never reached.
 *
 * Narrow by construction: the target must be *longer* than the field name (clicking the box itself is
 * ordinary), the field must be empty, and no fill may have landed in it — a box the app itself cleared
 * has been typed into, and that is a finding rather than a missing setup. Longest field name wins, so
 * "기관 코드 중복확인" is not answered by a field called "기관".
 */
export function untypedFieldInTarget(
	target: string,
	fields: Record<string, string> | undefined,
	landedKeys: readonly string[] = [],
): string | null {
	const t = looseText(target);
	if (!t) return null;
	const landed = new Set(landedKeys.map(looseText));
	let best: string | null = null;
	let bestLen = 0;
	for (const [key, value] of Object.entries(fields ?? {})) {
		if (value.trim() !== "") continue;
		const k = looseText(key);
		if (k.length < 2 || k.length <= bestLen || landed.has(k)) continue;
		if (!t.includes(k) || t.length <= k.length) continue;
		best = key;
		bestLen = k.length;
	}
	return best;
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
 * Exact, then whitespace/punctuation-insensitive — and deliberately no looser than that, in the
 * judgement layer specifically. A stem match on "아이디 입력란" resolved to a *different* box whose
 * placeholder shares the noun, one the case had never typed into, and its emptiness read as a working
 * restriction: two cases whose recorded defect is "the limit does not work" passed that way. Not
 * finding it fails instead, which is the safe answer — if the case's target is not what the check is
 * looking at, the check has learned nothing.
 *
 * A trailing UI noun is *not* stripped here, and the difference from the click and fill rankings is the
 * point. There, a widened candidate that picks the wrong element makes an action fail — visibly, as a
 * heal event. Here it makes a verdict. Measured: adding the strip to this lookup took a 98-case sheet
 * from 3 false passes to 5, and the two it added are the same pair as before — "아이디 입력란 내
 * 한글/대문자/특수문자 입력 → 입력 제한되어야 한다" and its 기관명 twin, both recorded by a human as
 * *the limit does not work*, both passed on a box that was empty because nothing had been typed into it.
 * A `fieldHolds`-style false fail (NO 222, "not on screen") is the price, and it is the cheaper one.
 */
function lookupLabelled<T>(map: Record<string, T> | undefined, label: string): { label: string; value: T } | null {
	const entries = map ?? {};
	const direct = entries[label];
	if (direct !== undefined) return { label, value: direct };
	const want = looseText(label);
	for (const [key, value] of Object.entries(entries)) {
		if (looseText(key) === want) return { label: key, value };
	}
	return null;
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

/**
 * Pure, deterministic evaluation of one assertion against a snapshot.
 *
 * `lenient` ignores whitespace/punctuation. `landings` maps each fill's target to the snapshot key of
 * the element it actually wrote — when present, a field check reads exactly the box that was typed
 * into, and a field nothing ever landed in fails instead of letting a same-named empty box answer.
 * Measured (NO 114): "아이디 입력란 내 한글/대문자/특수문자 입력 → 입력 제한되어야 한다" passed on an
 * empty 아이디 the case had never touched, while the app — probed live — accepts 한글ABC!@# verbatim.
 */
export function evaluateAssertion(
	a: Assertion,
	snap: PageSnapshot,
	opts: { lenient?: boolean; landings?: Record<string, string> } = {},
): AssertionResult {
	const has = (hay: string, needle: string) =>
		opts.lenient ? looseText(hay).includes(looseText(needle)) : hay.includes(needle);
	/** The box a field check may read: the landed one when landings are known, name lookup otherwise. */
	const typedField = (name: string): { found: { label: string; value: string } | null; miss: string } => {
		if (!opts.landings) {
			const found = lookupLabelled(snap.fields, name);
			return { found, miss: `field "${name}" not on screen` };
		}
		const want = looseText(name);
		const hit = Object.entries(opts.landings).find(([target]) => looseText(target) === want);
		if (!hit) return { found: null, miss: `no typed value ever landed in field "${name}"` };
		const value = snap.fields?.[hit[1]];
		if (value === undefined) return { found: null, miss: `field "${hit[1]}" not on screen` };
		return { found: { label: hit[1], value }, miss: "" };
	};
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
			// Cannot see the field → cannot verify the limit. Passing here is exactly the unsound shortcut
			// that let "입력 제한되어야 한다" go green on two cases whose recorded defect is that the limit
			// does not work: if the typed value never landed anywhere, nothing was ever restricted.
			const { found, miss } = typedField(a.field);
			if (!found) return { assertion: a, passed: false, detail: miss };
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
			const { found, miss } = typedField(a.field);
			if (!found) return { assertion: a, passed: false, detail: miss };
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
			const { found, miss } = typedField(a.field);
			if (!found) return { assertion: a, passed: false, detail: miss };
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
