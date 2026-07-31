/**
 * AI authoring (author-time). Converts a case's free natural-language steps into a
 * deterministic execution plan (page actions + assertions) via the model — no quoted
 * DSL required. The plan is authored ONCE and cached by (caseId, ruleId, ruleVersion,
 * caseHash); run-time replays the cached plan deterministically, so the LLM never
 * judges a run and re-runs stay identical (false-pass = 0).
 */

import { createHash } from "node:crypto";
import type { NormalizedTC } from "../intake/schema.ts";
import type { ModelClient } from "../model/model-client.ts";
import {
	type Assertion,
	AUTHOR_VERSION,
	assertionCacheKey,
	authorableAssertions,
	type CharClass,
	type ValueAssertion,
} from "./assertion.ts";
import { escapeRe, expectedRequirements, isProse, matchesPhrase, type PageAction } from "./interpret.ts";
import { normLabel, type RouteEntry } from "./recon.ts";
import { DEFAULT_CHAR_CLASSES, DEFAULT_PHRASES, extractJsonObject, type InterpretationRule } from "./rule.ts";

export interface AuthoredPlan {
	actions: PageAction[];
	assertions: Assertion[];
}

export interface PlanCacheEntry {
	key: string;
	plan: AuthoredPlan;
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

	/** Snapshot every cached plan for durable persistence. */
	entries(): PlanCacheEntry[] {
		return [...this.store.entries()].map(([key, plan]) => ({ key, plan: structuredClone(plan) }));
	}

	/** Replace cached plans from a persisted snapshot (keeps deterministic replay across restarts). */
	load(entries: PlanCacheEntry[]): void {
		this.store.clear();
		for (const { key, plan } of entries) this.store.set(key, structuredClone(plan));
	}
}

/** Kinds the model may author. Field kinds are derived by code and validated separately. */
const ASSERTION_KINDS = new Set<string>(["urlIncludes", "textIncludes", "textNotIncludes"]);
const isValueKind = (k: Assertion["kind"]): k is ValueAssertion["kind"] => ASSERTION_KINDS.has(k);

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
		else if (o.kind === "clickRow") {
			const nth = typeof o.nth === "number" ? o.nth : 1;
			if (Number.isInteger(nth) && nth >= 1) out.push({ kind: "clickRow", nth });
		} else if (o.kind === "fill" && typeof o.target === "string" && typeof o.value === "string" && o.target)
			out.push({ kind: "fill", target: o.target, value: o.value });
	}
	return out;
}

/** Longest a comma-separated part may be and still read as a UI label rather than a sentence. */
const ENUM_PART_MAX = 24;

/**
 * An enumerated expectation is one assertion per item, not one assertion per comma-joined string.
 *
 * Sheets list the contents of a filter or a table header inline: "필터 리스트 표출되어야 한다 - 가온,
 * 지자체, 공공기관, 위탁관리, 일반업체". The model faithfully copies that into a single
 * `textIncludes: "가온, 지자체, 공공기관, 위탁관리, 일반업체"`, and the page never contains that
 * string — it contains the five labels separately. Measured on the live app: all five were on screen,
 * the joined literal was not, and the case was unfalsifiable (it could only ever miss).
 *
 * Splitting is a replacement, not an addition: keeping the joined form would fail every run. Guarded
 * to actual enumerations — three or more short, non-prose parts — so "Welcome, admin" keeps its
 * stronger adjacency check instead of decaying into two loose word searches.
 */
export function splitEnumeratedValue(value: string): string[] {
	const parts = value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (parts.length < 3) return [value];
	if (parts.some((p) => p.length > ENUM_PART_MAX || isProse(p))) return [value];
	return parts;
}

/**
 * Derive the url assertion a navigation expectation deserves, from the routes recon actually saw.
 *
 * 56 of this sheet's 652 cases say the app must end up somewhere ("대시보드로 이동되어야 한다") and
 * only 4 were ever given a url assertion; the rest got text that is on the page either way, so the
 * outcome went unchecked. Asking the model for it in the prompt did nothing — measured 0/10 even with
 * the routes in front of it. So this is code, and the route table is the ground truth.
 *
 * Deliberately narrow, because a wrong route is a false fail:
 *  - the expectation has to actually claim a navigation;
 *  - the route label has to appear in that text (longest label wins — `routeTable` is pre-sorted);
 *  - two different paths matching equally well means the case is ambiguous, and nothing is authored.
 */
export function deriveRouteAssertion(
	expected: string,
	routes: readonly RouteEntry[] = [],
	phrases: readonly string[] = DEFAULT_PHRASES.navigation,
): Assertion | null {
	if (!matchesPhrase(expected, phrases)) return null;
	const best = matchRoute(expected, routes);
	return best ? { kind: "urlIncludes", value: best.path } : null;
}

/**
 * Read "12자 초과", "over 12 characters" — a number next to a unit word, with an exceed marker nearby.
 *
 * Word order differs by language, so the number may sit on either side of the unit. Built from the
 * rule's vocabulary rather than a regex literal: the old `(\d+)\s*자\s*(?:초과|이상)` had no English at
 * all, so an English sheet derived nothing and said nothing about it.
 */
function readLengthLimit(text: string, units: readonly string[], exceed: readonly string[]): number | null {
	if (!matchesPhrase(text, exceed)) return null;
	for (const unit of units) {
		const u = escapeRe(unit.trim());
		if (!u) continue;
		const m = new RegExp(`(\\d+)\\s*${u}|${u}\\s*(\\d+)`, "i").exec(text);
		const n = Number(m?.[1] ?? m?.[2]);
		if (Number.isInteger(n) && n > 0) return n;
	}
	return null;
}

/**
 * Turn "임의 계정 선택" into a row click, because there is no label to click.
 *
 * The most common instruction on the measured sheet — 124 of 652 cases say "pick any account / any
 * item" — and thirty times more common than every ordinal put together. A label-only action vocabulary
 * cannot express it, so the model authored `click "임의 계정"`, a target that has never existed on any
 * page, and the case failed before reaching whatever it was meant to verify.
 *
 * Both halves must be present: an "any/첫 번째" word *and* a noun that names a listed thing. "임의의
 * 문자를 입력" is not a row, and quietly clicking one would send the case somewhere it never asked to go.
 */
export function withRowClicks(
	actions: readonly PageAction[],
	vocab: { phrases?: Record<string, string[]> } = {},
): PageAction[] {
	const phrases = { ...DEFAULT_PHRASES, ...(vocab.phrases ?? {}) };
	return actions.map((a) => {
		if (a.kind !== "click") return a;
		const isAnyRow = matchesPhrase(a.target, phrases.anyRow) && matchesPhrase(a.target, phrases.rowNoun);
		return isAnyRow ? { kind: "clickRow", nth: 1 } : a;
	});
}

/**
 * Derive the check for "입력 제한되어야 한다" from the limit the case describes and the field it typed into.
 *
 * The largest unverifiable class on the measured sheet — 39 of 652 cases, and most of the cases in a
 * 98-case run that produced no assertion at all. The expectation has no literal to quote, and asserting
 * the requirement sentence verbatim is the false pass this engine refuses.
 *
 * A first attempt asserted the typed string was *absent* and had to be reverted: an app that truncates
 * 13 characters to 12 no longer contains the 13-character string, so partial acceptance read as a
 * restriction, and two cases whose recorded defect is "the limit does not work" went green. The sound
 * question is about the field's value itself — how long it is, and what kinds of character it holds —
 * which is why those became assertion kinds rather than another string search.
 *
 * The step says the limit ("12자 초과 입력", "특수문자 입력"); the plan's own `fill` says which field.
 * Both must be present, so nothing is derived from a case that only describes typing in prose.
 */
export function deriveRestrictionAssertions(
	expected: string,
	steps: readonly string[],
	actions: readonly PageAction[],
	vocab: { phrases?: Record<string, string[]>; charClasses?: Record<CharClass, string[]> } = {},
): Assertion[] {
	const phrases = { ...DEFAULT_PHRASES, ...(vocab.phrases ?? {}) };
	const charClasses = { ...DEFAULT_CHAR_CLASSES, ...(vocab.charClasses ?? {}) };
	if (!matchesPhrase(expected, phrases.restriction)) return [];
	const fields = actions.filter((a): a is PageAction & { kind: "fill" } => a.kind === "fill").map((a) => a.target);
	if (fields.length === 0) return [];
	const text = steps.join("\n");
	const out: Assertion[] = [];
	// "12자 초과 입력" means 12 is allowed and 13 is not.
	const max = readLengthLimit(text, phrases.lengthUnit, phrases.exceed);
	if (max !== null) for (const field of fields) out.push({ kind: "fieldAtMost", field, max });
	const classes = (Object.keys(charClasses) as CharClass[]).filter((c) => matchesPhrase(text, charClasses[c]));
	if (classes.length > 0) for (const field of fields) out.push({ kind: "fieldExcludes", field, classes });
	return out;
}

/**
 * Derive the check for "활성 라디오 버튼 선택되어야 한다" from the control the plan actually clicked.
 *
 * A radio's state is not text and not a value: the page reads the same whichever option is on, so this
 * whole class of expectation could only ever be held for review. Measured on the account editor, both
 * cases also *failed to click at all* — the real `<input>` sits at `opacity: 0` behind a painted label —
 * so nothing was verified twice over. Once the click lands, the state is right there to be read.
 *
 * Narrow on three counts, because a wrong control is a false fail and a wrong *reading* is worse:
 *  - the expectation has to name a radio/checkbox, so the sheet's far more common "메뉴가 선택되어야
 *    한다" (a text outcome) is left to the text assertions that can already see it;
 *  - the control comes from the plan's own `click`, never from the prose;
 *  - the expectation has to name that same control on a word boundary — "활성" sits inside "비활성",
 *    and a substring match would happily assert the opposite of what the case demands.
 */
export function deriveSelectionAssertions(
	expected: string,
	actions: readonly PageAction[],
	vocab: { phrases?: Record<string, string[]> } = {},
): Assertion[] {
	const phrases = { ...DEFAULT_PHRASES, ...(vocab.phrases ?? {}) };
	if (!matchesPhrase(expected, phrases.toggleNoun) || !matchesPhrase(expected, phrases.selected)) return [];
	const out: Assertion[] = [];
	for (const action of actions) {
		if (action.kind !== "click") continue;
		const control = action.target.trim();
		if (control.length >= 2 && namesOnWordBoundary(expected, control)) out.push({ kind: "controlSelected", control });
	}
	return out;
}

/**
 * Derive the check for "해당란에 반영되어야 한다" from the value the plan actually typed.
 *
 * The requirement is anaphoric — "해당란" is whatever box the *step* named — so there is no literal in
 * the expectation to quote, and the two gates that ask "does an assertion quote the requirement?" can
 * never be satisfied by one. Measured: NO 223 typed "테스트 소속 그룹", the field held it, a model-written
 * `textIncludes` even passed on it, and the case was still held because that string appears nowhere in
 * "해당란에 반영되어야 한다". The check that belongs here reads the field, and its value comes from the
 * plan's own `fill` rather than from a guess at the prose.
 *
 * Narrow the same way as the restriction checks: the expectation has to claim the input was kept, and
 * the plan has to have typed something. Prose alone derives nothing.
 */
export function deriveReflectionAssertions(
	expected: string,
	actions: readonly PageAction[],
	vocab: { phrases?: Record<string, string[]> } = {},
): Assertion[] {
	const phrases = { ...DEFAULT_PHRASES, ...(vocab.phrases ?? {}) };
	if (!matchesPhrase(expected, phrases.reflected)) return [];
	const out: Assertion[] = [];
	for (const action of actions) {
		if (action.kind !== "fill" || !action.target.trim() || !action.value) continue;
		out.push({ kind: "fieldHolds", field: action.target.trim(), value: action.value });
	}
	return out;
}

/**
 * Quote the copy a requirement writes out under itself, when the model quoted nothing at all.
 *
 * 278 of this sheet's 652 expected results carry a line like `- 검색된 목록이 없습니다.` — the exact
 * words the screen is supposed to show, sitting right under the sentence demanding them. Whether the
 * model picks that line up is a coin flip: NO 141 and 143 were authored with `textIncludes "이메일
 * 형식, 최대 255자"` under one roll and with no assertion at all under the next, and the English
 * fixture's EN-1 quoted the prose ("Welcome") instead of the literal beneath it ("Accounts"). The line
 * is right there; reading it is code's job, not a dice roll.
 *
 * Narrow on three counts, because a wrong quote is a false fail:
 *  - only when the model authored no text assertion at all — this fills a gap, it never competes with
 *    a choice the model actually made;
 *  - only lines opened by a quote marker. `*` is not one: on this sheet it introduces a note *about*
 *    the requirement ("* 기본값 : 전체", "* 기관 생성 시 작성한 유형값 반영"), which is not on screen;
 *  - and never a `라벨 : 값` annotation or a prose sentence — both describe the requirement rather
 *    than quoting the app.
 */
export function deriveQuotedAssertions(
	expected: string,
	authored: readonly Assertion[],
	vocab: { phrases?: Record<string, string[]> } = {},
): Assertion[] {
	if (authored.some((a) => a.kind === "textIncludes" || a.kind === "textNotIncludes")) return [];
	const markers = { ...DEFAULT_PHRASES, ...(vocab.phrases ?? {}) }.quotedLine;
	const out: Assertion[] = [];
	for (const requirement of expectedRequirements(expected)) {
		for (const line of requirement.split("\n").slice(1)) {
			const text = line.trim();
			const marker = markers.find((m) => m && text.startsWith(m));
			if (!marker) continue;
			const literal = text.slice(marker.length).trim();
			if (literal.length < 2 || literal.includes(":") || isProse(literal)) continue;
			// Split the same way a model-written enumeration is: four names on one line are four things
			// the screen must show, and the comma-joined string is on no page anywhere.
			for (const value of splitEnumeratedValue(literal)) out.push({ kind: "textIncludes", value });
		}
	}
	return out;
}

/** Does `text` contain `needle` as its own word — i.e. not welded to a letter or digit on either side? */
function namesOnWordBoundary(text: string, needle: string): boolean {
	const hay = text.toLowerCase();
	const want = needle.toLowerCase();
	const wordish = /[\p{L}\p{N}]/u;
	for (let i = hay.indexOf(want); i >= 0; i = hay.indexOf(want, i + 1)) {
		const before = hay[i - 1];
		const after = hay[i + want.length];
		if (!(before && wordish.test(before)) && !(after && wordish.test(after))) return true;
	}
	return false;
}

/**
 * Which route, if any, a piece of prose unambiguously names.
 *
 * Shared by the assertion above and by preparation, because both need the same question answered from
 * the same table: the model will not use a route even when it is handed one (measured 0/10 for
 * assertions, and 27 of 58 failed preparations were a click on prose like "전체 기관 관리" while
 * `기관 관리 = /agency` sat unused in the prompt). Prompt instructions are not a mechanism here.
 */
export function matchRoute(text: string, routes: readonly RouteEntry[] = []): RouteEntry | null {
	if (routes.length === 0) return null;
	const haystack = normLabel(text);
	const hits = routes.filter((r) => {
		// A "/" route is contained in every url and names every page — it identifies nothing.
		// Recon does produce these: a dashboard's 일간/월간 toggles are anchors with no real href.
		if (r.path === "/") return false;
		const label = normLabel(r.label);
		return label.length >= 2 && haystack.includes(label);
	});
	const best = hits[0];
	if (!best) return null;
	// Same label length, different destination → we cannot tell which was meant.
	if (hits.some((h) => h.path !== best.path && h.label.length === best.label.length)) return null;
	return best;
}

/**
 * Keep only well-formed, deduped assertions.
 *
 * Prose is dropped even though the prompt forbids it, because the model authors it anyway: a real
 * run against a live sheet produced `textIncludes: "1. 팝업이 종료되어야 한다."` — the requirement
 * sentence itself, which is not page text. With lenient matching on, that near-missed its way to a
 * `pass` on a case a human had marked Fail. The deterministic path has refused prose since
 * 2026-07-27; the model path is held to the same rule, and a case left with no assertion falls to
 * review rather than to a verdict nobody earned.
 */
const CHAR_CLASSES = new Set<CharClass>(["hangul", "upper", "symbol", "nonDigit"]);

/** Validate a code-derived (non string-valued) assertion off the wire or off disk; null when malformed. */
function sanitizeStructuredAssertion(kind: Assertion["kind"], o: Record<string, unknown>): Assertion | null {
	if (kind === "controlSelected") {
		const control = typeof o.control === "string" ? o.control.trim() : "";
		return control ? { kind, control } : null;
	}
	if (typeof o.field !== "string" || !o.field.trim()) return null;
	if (kind === "fieldHolds") {
		return typeof o.value === "string" && o.value ? { kind, field: o.field.trim(), value: o.value } : null;
	}
	if (kind === "fieldAtMost") {
		const max = typeof o.max === "number" ? o.max : Number.NaN;
		return Number.isInteger(max) && max >= 0 ? { kind, field: o.field.trim(), max } : null;
	}
	if (kind === "fieldExcludes") {
		const classes = Array.isArray(o.classes)
			? o.classes.filter((c): c is CharClass => CHAR_CLASSES.has(c as CharClass))
			: [];
		return classes.length ? { kind, field: o.field.trim(), classes: [...new Set(classes)] } : null;
	}
	return null;
}

function sanitizeAssertions(raw: unknown): Assertion[] {
	if (!Array.isArray(raw)) return [];
	const out: Assertion[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const o = item as Record<string, unknown>;
		const kind = o.kind as Assertion["kind"];
		// Field and control assertions are derived by code, never written by the model — but cached plans
		// are re-sanitized on read, so they have to survive this or they vanish from every sheet that ran.
		const structured = sanitizeStructuredAssertion(kind, o);
		if (structured) {
			const key = JSON.stringify(structured);
			if (!seen.has(key)) {
				seen.add(key);
				out.push(structured);
			}
			continue;
		}
		if (!isValueKind(kind) || typeof o.value !== "string" || !o.value || isProse(o.value)) continue;
		// Only `textIncludes` enumerations split. "not includes A, B, C" is a single typed string in
		// practice, and a url is never a list.
		const values = kind === "textIncludes" ? splitEnumeratedValue(o.value) : [o.value];
		for (const value of values) {
			const key = `${kind}:${value}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ kind, value });
		}
	}
	return out;
}

export interface AuthorContext {
	referenceRepo?: string;
	username?: string;
	password?: string;
}

/** Author a plan from natural-language steps via the model (author-time). */
export async function authorPlanAI(
	tc: NormalizedTC,
	model: ModelClient,
	context: AuthorContext = {},
	rule?: InterpretationRule,
): Promise<AuthoredPlan> {
	const system =
		"You convert a web test case's natural-language steps into a deterministic browser execution plan. " +
		'Output ONLY JSON: {"actions":[...],"assertions":[...]}. actions items are ' +
		'{"kind":"goto","path":"/..."} | {"kind":"click","target":"<visible label/text/role name>"} | ' +
		'{"kind":"fill","target":"<field label>","value":"<text>"}. assertions items are ' +
		'{"kind":"textIncludes","value":"..."} | {"kind":"urlIncludes","value":"..."} | {"kind":"textNotIncludes","value":"..."}. ' +
		"Derive assertions ONLY from the Expected result and explicit verify/assert steps; never assert page boilerplate (nav, headings, static button labels) or text that appears regardless of outcome — that risks a false pass. " +
		"Use textNotIncludes when the expected outcome is that something must NOT appear (e.g. 'must not', 'should not show', or staying on the same page). " +
		// 56 of this sheet's 652 cases expect a navigation and only 4 were given a url assertion; the
		// rest got text that is on the page either way, so the outcome went unchecked. Routes only reach
		// the prompt once app analysis has run, so this stays inert — by design — without them.
		"When the Expected result says the app must navigate somewhere (이동/전환/moves to/redirects), assert it with urlIncludes using a route that appears in the app context above — never invent a path, and author no url assertion at all if no listed route matches. " +
		"Prefer one or two specific assertions; if the expected outcome is unclear, author fewer rather than guessing (a missing assertion is safer than a false pass). " +
		"Targets must be user-visible text, never CSS. Output ONLY the JSON.";
	const ctx: string[] = [];
	if (context.referenceRepo) ctx.push(`App reference repo (for domain context): ${context.referenceRepo}`);
	if (context.username) ctx.push(`Test account username: ${context.username}`);
	if (context.password) ctx.push(`Test account password: ${context.password}`);
	const ctxBlock = ctx.length ? `\nContext (use for login/fill steps when relevant):\n${ctx.join("\n")}` : "";
	const guide: string[] = [];
	if (rule?.appContext?.trim()) guide.push(rule.appContext.trim());
	if (rule?.codeContext?.trim()) guide.push(`App code context (from the reference repo) — ${rule.codeContext.trim()}`);
	if (rule) {
		const vocab = Object.entries(rule.intents)
			.filter(([, v]) => v.length > 0)
			.map(([k, v]) => `${k}: ${v.join(", ")}`);
		if (vocab.length) guide.push(`Team step vocabulary — ${vocab.join(" | ")}`);
		if (rule.destructiveKeywords.length)
			guide.push(`Destructive-step markers (be precise, avoid extra clicks): ${rule.destructiveKeywords.join(", ")}`);
	}
	const guideBlock = guide.length
		? `\nApp context & vocabulary (use to interpret the steps):\n${guide.map((g) => `- ${g}`).join("\n")}`
		: "";
	const user = `TITLE: ${tc.title}\nSTEPS:\n${tc.steps.map((s) => `- ${s}`).join("\n")}\nEXPECTED: ${tc.expected}${guideBlock}${ctxBlock}`;
	const obj =
		extractJsonObject(
			await model.complete(
				[
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
				// Structured extraction, not deliberation: measured against this app's real sheet, the
				// model's default effort cost ~35% more wall clock for no better plan.
				{ defaultEffort: "low" },
			),
		) ?? {};
	// Only what the model wrote. The code-derived checks are applied when the plan is *read*
	// (`withDerivedAssertions`), never baked in here — see that function for why.
	return {
		actions: withRowClicks(sanitizeActions(obj.actions), { phrases: rule?.phrases }),
		assertions: sanitizeAssertions(obj.assertions),
	};
}

/**
 * Add the checks code can derive from ground truth, to a plan the model already wrote.
 *
 * Four of them now: the route table says where "…로 이동되어야 한다" lands, the step's stated limit plus
 * the plan's own fill target say what "입력 제한되어야 한다" means for that field, the plan's own click
 * says which control "…라디오 버튼 선택되어야 한다" is about, and the plan's own typed value says what
 * "해당란에 반영되어야 한다" is claiming. None of them replaces the model's work; a url the model wrote
 * is never overridden.
 *
 * Applied on *read*, not at authoring time, and that is the whole point. Derived checks are a pure
 * function of (case, rule, actions), so baking them into the cache made them as stale as the day they
 * were written: the only way to give an already-run sheet a newly added check was to bump
 * `AUTHOR_VERSION`, which re-rolls every cached plan through the model. Measured in one session — three
 * bumps, and each one moved the scorecard by ±2 cases for reasons that had nothing to do with the
 * change being measured (NO 141 and 143 held a `textIncludes` under one roll and no assertion at all
 * under the next, same case, same prompt, same pinned model). Deriving on read means a judgement change
 * reaches every sheet immediately and a measurement compares like with like.
 */
export function withDerivedAssertions(
	tc: NormalizedTC,
	rule: InterpretationRule | undefined,
	plan: AuthoredPlan,
): AuthoredPlan {
	const { actions, assertions } = plan;
	const route = assertions.some((a) => a.kind === "urlIncludes")
		? null
		: deriveRouteAssertion(tc.expected, rule?.routes);
	const restrictions = deriveRestrictionAssertions(tc.expected, tc.steps, actions, {
		phrases: rule?.phrases,
		charClasses: rule?.charClasses,
	});
	const selections = deriveSelectionAssertions(tc.expected, actions, { phrases: rule?.phrases });
	const reflections = deriveReflectionAssertions(tc.expected, actions, { phrases: rule?.phrases });
	const quoted = deriveQuotedAssertions(tc.expected, assertions, { phrases: rule?.phrases });
	return {
		actions,
		// Deduped and filtered through the one funnel both authoring paths share, so a check the engine
		// refuses to judge is refused whether the model wrote it or the rule derived it.
		assertions: authorableAssertions([
			...assertions,
			...(route ? [route] : []),
			...restrictions,
			...selections,
			...reflections,
			...quoted,
		]),
	};
}

/**
 * Cache key for a preparation plan: the precondition text itself, not the case.
 *
 * Seven cases in one measured sheet share "계정 관리 페이지 내 신규 계정 생성 버튼 선택된 상태". Keying on
 * the text means they author one plan between them, and editing a precondition invalidates only its
 * own plan — which is also why the precondition stays out of `contentHash` and leaves `caseId`, and
 * every approved baseline, alone.
 */
export function preparationCacheKey(precondition: string, ruleId: string, ruleVersion: number): string {
	const canonical = precondition.replace(/\s+/g, " ").trim();
	const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
	return `prep|${ruleId}|v${ruleVersion}|a${AUTHOR_VERSION}|${hash}`;
}

/**
 * Turn a written precondition into the actions that reach that starting state.
 *
 * Measured on a real sheet: of 57 cases the engine could not drive, **all 57** had a precondition
 * written in the sheet and the engine had never read it. It was being dropped at ingest, so the model
 * re-derived the setup mid-run through the repair path instead — 28 times in one 98-case run, at a
 * model round trip each, and every recovery is a heal event that caps the case at `needs_review`. The
 * same information was sitting in the next column.
 *
 * Actions only. A precondition is where the case starts, never something to assert: authoring a check
 * from it would test the setup and report it as the case's own result.
 */
export async function authorPreparation(
	precondition: string,
	model: ModelClient,
	rule?: InterpretationRule,
): Promise<PageAction[]> {
	const text = precondition.trim();
	if (!text) return [];
	const routes = (rule?.routes ?? []).filter((r) => r.path !== "/");
	const system =
		"You turn a QA case's PRECONDITION — the state the app must already be in before the case's own steps run — into the minimal browser actions that reach it. " +
		'Reply ONLY with JSON: {"actions":[...]} where each action is ' +
		'{"kind":"goto","path":"/..."} | {"kind":"click","target":"visible text"} | {"kind":"fill","target":"field label","value":"..."}. ' +
		"Reach the state and stop. Never perform what the case itself is supposed to test, never submit a form, and never assert anything. " +
		"Prefer goto with a route listed below over clicking through a menu. Targets must be user-visible text, never CSS. " +
		"If the precondition only restates being logged in or being on the app at all, reply with an empty actions array — the runner already handles sessions. " +
		(routes.length ? `Known routes: ${routes.map((r) => `${r.label} = ${r.path}`).join(", ")}. ` : "") +
		"Output ONLY the JSON.";
	const guide = [rule?.appContext?.trim(), rule?.codeContext?.trim()].filter(Boolean);
	const user = `PRECONDITION:\n${text}${guide.length ? `\n\nApp context:\n${guide.map((g) => `- ${g}`).join("\n")}` : ""}`;
	const obj =
		extractJsonObject(
			await model.complete(
				[
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
				{ defaultEffort: "low" },
			),
		) ?? {};
	return derivePreparationActions(text, sanitizeActions(obj.actions), rule?.routes);
}

/**
 * Put the navigation part of a preparation on rails: the route table decides it, not the model.
 *
 * Measured on a 98-case run, 58 preparations failed and 27 of those were a click on the precondition's
 * own prose — `click "전체 기관 관리"` (a heading, not a control), `click "계정 관리"`, `click "관리자
 * 대시보드"` — while `기관 관리 = /agency` and `계정 관리 = /account` sat unused in the same prompt. The
 * model echoes the sheet's words instead of reading the table, exactly as it ignored the instruction to
 * author a url assertion. So the goto is derived here and the model's duplicate nav clicks are dropped;
 * whatever is left (opening a popup, selecting a row) is still its job.
 */
export function derivePreparationActions(
	precondition: string,
	modelActions: readonly PageAction[],
	routes: readonly RouteEntry[] = [],
	phrases: Record<string, string[]> = DEFAULT_PHRASES,
): PageAction[] {
	/**
	 * "임의 계정 선택된 상태" is a precondition far more often than a step, and there is no label to click.
	 * Measured, the model's preparation for it was `click "1"` — a pagination number — or nothing at all,
	 * so the edit popup stayed shut and the case's own steps then failed on fields inside it. A numeric
	 * click is dropped: it never selects a row, and clicking page 2 moves the list instead.
	 */
	const vocab = { ...DEFAULT_PHRASES, ...phrases };
	const needsRow = matchesPhrase(precondition, vocab.anyRow) && matchesPhrase(precondition, vocab.rowNoun);
	const isPageNumber = (a: PageAction): boolean => a.kind === "click" && /^\d+$/.test(a.target.trim());
	const kept = modelActions.filter((a) => !(needsRow && isPageNumber(a)));
	const rowClick: PageAction[] =
		needsRow && !kept.some((a) => a.kind === "clickRow") ? [{ kind: "clickRow", nth: 1 }] : [];
	const route = matchRoute(precondition, routes);
	if (!route) return [...kept, ...rowClick];
	const coversRoute = (a: PageAction): boolean =>
		(a.kind === "click" && matchRoute(a.target, routes)?.path === route.path) ||
		(a.kind === "goto" && (a.path.split(/[?#]/)[0] ?? "").replace(/\/+$/, "") === route.path);
	// The precondition names the screen; navigating straight there is both the correct reading and
	// idempotent, where a menu click depends on where the previous case happened to leave us.
	return [{ kind: "goto", path: route.path }, ...kept.filter((a) => !coversRoute(a)), ...rowClick];
}

export interface AuthoredPlanResult {
	plan: AuthoredPlan;
	cacheHit: boolean;
	key: string;
}

/**
 * Read a cached plan or author + cache it (author-once per case + rule version).
 *
 * A cached plan is re-sanitized on the way out, not trusted as-is. The plan cache is persisted per
 * sheet, so without this a plan authored under looser rules keeps its illegitimate assertions
 * forever — tightening what may be asserted would fix nothing for exactly the sheets that had
 * already run. Sanitizing is pure and idempotent, so a plan authored under the current rules passes
 * through unchanged.
 */
export async function getOrAuthorPlan(
	tc: NormalizedTC,
	rule: InterpretationRule,
	cache: PlanCache,
	model: ModelClient,
	context: AuthorContext = {},
): Promise<AuthoredPlanResult> {
	const key = assertionCacheKey(tc.caseId, rule.ruleId, rule.ruleVersion, tc.contentHash);
	const cached = cache.get(key);
	if (cached) {
		const plan = {
			actions: withRowClicks(sanitizeActions(cached.actions), { phrases: rule.phrases }),
			assertions: sanitizeAssertions(cached.assertions),
		};
		return { plan: withDerivedAssertions(tc, rule, plan), cacheHit: true, key };
	}
	const authored = await authorPlanAI(tc, model, context, rule);
	// The cache holds the model's output. Derived checks are recomputed on every read, so improving one
	// reaches a sheet that already ran instead of waiting for a re-author it would also be re-rolled by.
	cache.set(key, authored);
	return { plan: withDerivedAssertions(tc, rule, authored), cacheHit: false, key };
}
