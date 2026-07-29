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
import { isProse, type PageAction } from "./interpret.ts";
import { normLabel, type RouteEntry } from "./recon.ts";
import { extractJsonObject, type InterpretationRule } from "./rule.ts";

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

/** Longest a comma-separated part may be and still read as a UI label rather than a sentence. */
const ENUM_PART_MAX = 24;

/**
 * An enumerated expectation is one assertion per item, not one assertion per comma-joined string.
 *
 * Sheets list the contents of a filter or a table header inline: "필터 리스트 표출되어야 한다 - 이지스,
 * 지자체, 공공기관, 위탁관리, 일반업체". The model faithfully copies that into a single
 * `textIncludes: "이지스, 지자체, 공공기관, 위탁관리, 일반업체"`, and the page never contains that
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

/** Wording that makes an expected result a claim about *where the app ended up*. */
const NAVIGATION_RE = /이동|전환|redirect|navigat|moves? to/i;

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
export function deriveRouteAssertion(expected: string, routes: readonly RouteEntry[] = []): Assertion | null {
	if (!NAVIGATION_RE.test(expected) || routes.length === 0) return null;
	const haystack = normLabel(expected);
	const hits = routes.filter((r) => {
		// `urlIncludes: "/"` is contained in every path — a check that cannot fail is not a check.
		// Recon does produce these: a dashboard's 일간/월간 toggles are anchors with no real href.
		if (r.path === "/") return false;
		const label = normLabel(r.label);
		return label.length >= 2 && haystack.includes(label);
	});
	const best = hits[0];
	if (!best) return null;
	// Same label length, different destination → we cannot tell which was meant.
	if (hits.some((h) => h.path !== best.path && h.label.length === best.label.length)) return null;
	return { kind: "urlIncludes", value: best.path };
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
function sanitizeAssertions(raw: unknown): Assertion[] {
	if (!Array.isArray(raw)) return [];
	const out: Assertion[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const o = item as Record<string, unknown>;
		const kind = o.kind as Assertion["kind"];
		if (!ASSERTION_KINDS.has(kind) || typeof o.value !== "string" || !o.value || isProse(o.value)) continue;
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
	const assertions = sanitizeAssertions(obj.assertions);
	// Add the url assertion the model does not author, when the route table makes it unambiguous.
	// Never replaces one it did author.
	const route = assertions.some((a) => a.kind === "urlIncludes")
		? null
		: deriveRouteAssertion(tc.expected, rule?.routes);
	return { actions: sanitizeActions(obj.actions), assertions: route ? [...assertions, route] : assertions };
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
		const plan = { actions: sanitizeActions(cached.actions), assertions: sanitizeAssertions(cached.assertions) };
		return { plan, cacheHit: true, key };
	}
	const plan = await authorPlanAI(tc, model, context, rule);
	cache.set(key, plan);
	return { plan, cacheHit: false, key };
}
