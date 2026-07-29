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

/** Regex-escape a user-supplied intent keyword before splicing it into a pattern. */
function escapeRe(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** UI nouns a step appends to a label ("로그인 버튼", "Save button") that the DOM's own label omits. */
const UI_NOUN_RE = /\s*(버튼|링크|메뉴|탭|아이콘|영역|필드|입력란|체크박스|button|link|menu|tab|icon|field|checkbox)$/i;

/**
 * Reduce a natural-language step to the element label it names.
 *
 * Korean steps carry a list ordinal, a trailing action verb with arbitrary conjugation, and a
 * particle before it ("1. 로그인 버튼을 클릭한다" → "로그인"). Handing that whole sentence to a
 * locator matches nothing, which is why an English-only cleanup made every Korean click a miss.
 */
export function stepTarget(step: string, verbs: string[]): string {
	let s = step
		.replace(/^\s*\d+[.)]\s*/, "")
		.replace(/^\s*[-*·•]\s*/, "")
		.replace(/"[^"]*"/g, " ")
		.replace(/\b(click|press|tap|select|enter|type|fill|input|into|in|on|the)\b/gi, " ")
		.trim();
	const korean = verbs.filter((v) => /[가-힣]/.test(v)).map(escapeRe);
	if (korean.length > 0) {
		// Drop the trailing word that carries the action verb, whatever ending it was conjugated with.
		s = s.replace(new RegExp(`\\s*\\S*(?:${korean.join("|")})\\S*\\s*$`), "");
		s = s.replace(/\s*(을|를|이|가|은|는|에|에서|으로|로)$/, "");
	}
	return s.replace(UI_NOUN_RE, "").replace(/\s+/g, " ").trim();
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
			return { kind: "fill", target: stepTarget(step, rule.intents.input), value: quoted[0] ?? "" };
		}
	}
	if (matchesIntent(step, rule.intents.click)) {
		const target = extractQuoted(step)[0] ?? stepTarget(step, rule.intents.click);
		// A step whose only content was the verb ("선택한다") names nothing to click.
		if (target) return { kind: "click", target };
	}
	if (matchesIntent(step, rule.intents.verify)) {
		return { kind: "verify", text: step };
	}
	return { kind: "unknown", text: step };
}

/**
 * A written requirement ("팝업이 표출되어야 한다.", "the badge should turn green") describes an
 * outcome in prose — that sentence is never DOM text. Asserting it verbatim manufactures a verdict
 * the engine did not earn: a `fail` that blames the app for the engine's inability to check it, or
 * (with lenient matching on) a `pass` from a near-miss against unrelated copy. Both authoring paths
 * stay silent instead: the case lands in review, where a human decides.
 */
export function isProse(text: string): boolean {
	return /(되어야|해야|하여야|한다\.?$|합니다\.?$|바랍니다|should|must)/.test(text.trim());
}

/**
 * Split a written expected result into its top-level numbered requirements, each carrying the
 * detail lines that belong to it.
 *
 * Real sheets list several outcomes under one case ("1. 로고 표출… 2. 아이디 입력란 표출… 3. 찾기 버튼
 * 표출…"): 36% of this sheet's 652 cases have two or more. A `-`/`*`/`·` line is a detail of the
 * item above it, not a requirement of its own, so it stays attached instead of inflating the count.
 */
export function expectedRequirements(expected: string): string[] {
	const lines = (expected ?? "").split("\n");
	const out: string[] = [];
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;
		if (/^\d+[.)]\s*\S/.test(line)) out.push(line);
		else if (out.length > 0) out[out.length - 1] += `\n${line}`;
	}
	return out;
}

export interface RequirementCoverage {
	total: number;
	covered: number;
	/** Requirements no assertion refers to — the part of the case nothing actually checked. */
	missing: string[];
}

/**
 * Which of a case's written requirements the authored assertions actually refer to.
 *
 * A case can pass every assertion and still have left most of its expected result unchecked.
 * Measured: NO 137 lists four outcomes (columns, ordering, two maskings) and the model authored two
 * assertions — the human's recorded defect was the ordering, which nothing tested, and the case
 * passed. Attribution is deterministic on purpose (an assertion covers a requirement when its value
 * occurs in that requirement's text), so it also works on plans cached before this existed and does
 * not depend on the model reporting its own coverage honestly.
 *
 * With a single requirement this answers a narrower but sharper question: is *any* assertion about the
 * expectation at all? Two measured false passes were exactly that — a case demanding "새비밀번호 12자
 * 초과 → 입력 제한되어야 한다" passed on `textIncludes "이메일 형식, 최대 255자"` (the email field's
 * hint, unrelated to the case), and one demanding "하단 문구가 붉은색으로 표시되어야 한다" passed on the
 * hint's *content*, which no colour requirement can be read from. Both had a green check that was
 * never about the requirement.
 *
 * Only text assertions count toward attribution: a `urlIncludes` is derived from the expectation by
 * construction, so demanding its path appear in the prose would reject every one of them.
 */
export function requirementCoverage(expected: string, assertions: readonly Assertion[]): RequirementCoverage | null {
	const reqs = expectedRequirements(expected);
	if (reqs.length === 0) return null;
	const loose = (s: string) => s.replace(/\s+/g, "").toLowerCase();
	const values = assertions
		.filter((a) => a.kind === "textIncludes" || a.kind === "textNotIncludes")
		.map((a) => loose(String(a.value ?? "")))
		.filter((v) => v.length >= 2);
	const missing = reqs.filter((req) => {
		const hay = loose(req);
		return !values.some((v) => hay.includes(v));
	});
	return { total: reqs.length, covered: reqs.length - missing.length, missing };
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
	if (tc.expected && !isProse(tc.expected)) assertions.push({ kind: "textIncludes", value: tc.expected });
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
