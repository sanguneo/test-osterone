/**
 * In-run step repair — the one place the model participates *during* a run.
 *
 * Author-time planning is blind: it turns case prose into actions without ever having seen the
 * app. When an action then misses the live DOM (label reworded, a modal in the way, the app
 * landed on a different screen), replaying the rest of the plan is worse than useless — it acts
 * on a page the plan does not describe. This seam takes the failed action plus a structural scan
 * of what is *actually* on screen and asks the model for one corrected action.
 *
 * Trust rules (why this cannot become a false-pass vector):
 *  - the reply is **grounded**: a repaired target must resolve to a label the scan really contains,
 *    and a repaired route must be a link the page really exposes — anything invented is dropped;
 *  - a repair never changes the verdict logic: the runner records it as a heal event, so a repaired
 *    case is capped at `needs_review` and only a human-approved baseline can lift it to pass;
 *  - the model may answer `{"kind":"none"}`, and giving up is the preferred answer when unsure.
 */

import type { ContentPart, ModelClient } from "../model/model-client.ts";
import type { PageAction } from "./interpret.ts";
import { extractStructure, normLabel, pickFieldLabel, type ReconPage, renderPageForPrompt } from "./recon.ts";
import { extractJsonObject } from "./rule.ts";

export interface RepairRequest {
	/** The action that could not be performed. */
	action: PageAction;
	/** Playwright's failure message (already through the runner's retry). */
	error: string;
	/** Live page at the moment of failure. */
	html: string;
	url: string;
	/** Optional screenshot (data URL) so the model can see a blocking popup the DOM does not explain. */
	screenshot?: string;
	/** Case intent, so the repair serves the test's goal rather than the literal selector. */
	title?: string;
	steps?: string[];
	expected?: string;
}

/**
 * Clickable vocabulary the live page exposes.
 *
 * Form controls belong here even though they are not buttons: a filter or a dropdown is *clicked* to
 * open it, and the sheets this engine reads are full of "기관유형 필터 선택". Leaving them out made
 * `groundAction` disagree with `targetOnScreen` in the same file — the runner believed the target was
 * on screen and spent the full locator budget waiting for it, while grounding refused to snap it onto
 * the label the page actually carries (measured: `기관유형` → `기관 유형` was there for the taking).
 *
 * Ordered: real buttons and links win, so a page with both a "검색" button and a "검색" field still
 * clicks the button.
 */
function clickableLabels(scan: ReconPage): string[] {
	return [...scan.buttons, ...scan.links.map((l) => l.label), ...scan.headings, ...scan.formFields];
}

/**
 * Snap a proposed action onto the live page, or reject it. Returns the action rewritten with the
 * exact on-screen label (so the executor's locator gets the real text, not the model's paraphrase).
 */
export function groundAction(candidate: PageAction, scan: ReconPage): PageAction | null {
	if (candidate.kind === "goto") {
		const path = candidate.path.trim().split("#")[0] ?? "";
		if (!path.startsWith("/")) return null;
		const linked = scan.links.some((l) => (l.href.trim().split("#")[0] ?? "") === path);
		return linked || path === "/" ? { kind: "goto", path } : null;
	}
	if (candidate.kind === "click") {
		const label = pickFieldLabel(clickableLabels(scan), [candidate.target]);
		return label ? { kind: "click", target: label } : null;
	}
	if (candidate.kind === "fill") {
		const label = pickFieldLabel(scan.formFields, [candidate.target]);
		return label ? { kind: "fill", target: label, value: candidate.value } : null;
	}
	return null;
}

export interface Pregrounded {
	action: PageAction;
	/**
	 * True when the only difference was spacing/punctuation — the same element under a normalized
	 * name. False when the target merely *matched part of* a longer label, which is a guess about
	 * which element was meant and has to stay visible to a human.
	 */
	normalizedOnly: boolean;
}

/**
 * Snap a planned action onto the live page *before* attempting it — but only when it has drifted.
 *
 * Plans are authored blind, so their labels carry the sheet's wording, not the app's. Today that costs
 * a full locator timeout, then a patient retry, then a model round trip, and the repair is recorded as
 * a heal event — so a case whose only problem was a stray space is capped at `needs_review`. The
 * grounding is already deterministic; doing it up front removes the detour and the model call.
 *
 * An exact match is left strictly alone. Rewriting a target that already resolves could only break a
 * working case on a page where something else also fuzzy-matches, and buys nothing.
 */
export function pregroundAction(action: PageAction, html: string, url: string): Pregrounded | null {
	if (action.kind !== "click" && action.kind !== "fill") return null;
	const scan = extractStructure(html, url);
	const vocabulary = action.kind === "fill" ? scan.formFields : clickableLabels(scan);
	// Nothing painted yet: a slow mount must not be mistaken for drift.
	if (vocabulary.length === 0) return null;
	if (vocabulary.includes(action.target)) return null;
	const grounded = groundAction(action, scan);
	if (!grounded || grounded.kind !== action.kind || grounded.target === action.target) return null;
	return { action: grounded, normalizedOnly: normLabel(grounded.target) === normLabel(action.target) };
}

/**
 * Is this action's target present on the live screen at all? A miss costs the full locator timeout
 * twice (first try, then the patient retry after overlay recovery) — but when the label simply is
 * not in the DOM, that second wait can only ever expire. One cheap scan replaces it.
 *
 * Conservative by design: it answers `true` ("stay patient") whenever the page has not rendered
 * anything yet, so a slow mount is never mistaken for a missing element.
 */
export function targetOnScreen(action: PageAction, html: string, url: string): boolean {
	if (action.kind !== "click" && action.kind !== "fill") return true;
	const scan = extractStructure(html, url);
	const labels = [...clickableLabels(scan), ...scan.formFields, ...scan.tableHeaders];
	if (labels.length === 0) return true;
	return pickFieldLabel(labels, [action.target]) !== null;
}

/** Read one action out of the model's JSON reply (shape-checked, before grounding). */
function parseCandidate(obj: Record<string, unknown>): PageAction | null {
	if (obj.kind === "goto" && typeof obj.path === "string" && obj.path) return { kind: "goto", path: obj.path };
	if (obj.kind === "click" && typeof obj.target === "string" && obj.target)
		return { kind: "click", target: obj.target };
	if (obj.kind === "fill" && typeof obj.target === "string" && typeof obj.value === "string" && obj.target)
		return { kind: "fill", target: obj.target, value: obj.value };
	return null;
}

const REPAIR_SYSTEM =
	"A browser test step just failed because its target could not be found or acted on. You are given the case's " +
	"intent, the failed action, the error, and a structural scan of the page that is ACTUALLY on screen right now. " +
	"Propose ONE corrected action that serves the same intent, using ONLY labels/routes that appear verbatim in the scan. " +
	'Output ONLY JSON, one of: {"kind":"click","target":"<label from the scan>"} | ' +
	'{"kind":"fill","target":"<field label from the scan>","value":"<text>"} | {"kind":"goto","path":"/<route linked on the page>"} | ' +
	'{"kind":"none"}. ' +
	"Answer none when the screen cannot serve the intent (wrong page, blocking dialog you cannot name, nothing equivalent) — " +
	"giving up is correct and a wrong guess corrupts the rest of the test. Never invent a label, a field, or a route.";

function describeAction(a: PageAction): string {
	if (a.kind === "goto") return `goto ${a.path}`;
	if (a.kind === "click") return `click "${a.target}"`;
	if (a.kind === "fill") return `fill "${a.target}" with "${a.value}"`;
	return a.kind;
}

/**
 * Ask the model for a grounded replacement action. Returns null when the model declines, replies
 * with garbage, or names anything the live page does not actually have.
 */
export async function repairAction(model: ModelClient, req: RepairRequest): Promise<PageAction | null> {
	const scan = extractStructure(req.html, req.url);
	const intent = [
		req.title ? `CASE: ${req.title}` : "",
		req.steps?.length ? `STEPS:\n${req.steps.map((s) => `- ${s}`).join("\n")}` : "",
		req.expected ? `EXPECTED: ${req.expected}` : "",
	]
		.filter(Boolean)
		.join("\n");
	const text = `${intent ? `${intent}\n\n` : ""}FAILED ACTION: ${describeAction(req.action)}\nERROR: ${req.error}\n\nLIVE PAGE SCAN:\n${renderPageForPrompt(scan)}`;
	// Send the screenshot too when we have one: a blocking popup or a spinner is visible long
	// before it is explainable from the DOM scan alone.
	const content: string | ContentPart[] = req.screenshot
		? [
				{ type: "text", text },
				{ type: "image", imageUrl: req.screenshot },
			]
		: text;
	// This call sits between the browser and the next action — latency here is dead time in the run.
	const reply = await model.complete(
		[
			{ role: "system", content: REPAIR_SYSTEM },
			{ role: "user", content },
		],
		{ defaultEffort: "low" },
	);
	const obj = extractJsonObject(reply);
	if (!obj || obj.kind === "none") return null;
	const candidate = parseCandidate(obj);
	return candidate ? groundAction(candidate, scan) : null;
}
