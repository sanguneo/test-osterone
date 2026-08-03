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
import { DEFAULT_PHRASES, extractJsonObject } from "./rule.ts";

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
	/**
	 * What the live page will actually respond to a click on, computed in the browser.
	 *
	 * The scan below reads the HTML string, so it only ever sees controls the markup declares —
	 * buttons, links, headings, form fields. An app's dropdown trigger is routinely a `div` with a
	 * class, no role and no aria-label, marked clickable by `cursor: pointer` alone; no amount of regex
	 * finds it. Probed live: the account menu a case has to open is exactly that, it shows up here as
	 * the username it wraps, and a plain text locator clicks it successfully. Without this the model has
	 * no name to propose and grounding would refuse the right answer.
	 */
	clickables?: string[];
	/** The sheet's vocabulary, so `abandonControl` is teachable rather than hard-coded. */
	phrases?: Record<string, string[]>;
	/** Case intent, so the repair serves the test's goal rather than the literal selector. */
	title?: string;
	steps?: string[];
	expected?: string;
}

/**
 * A grounded repair, and how it relates to the action that failed.
 *
 * `before: false` is a substitution — the proposal *is* the failed action under the label the page
 * actually carries, so performing it is the step. `before: true` is an unblock: the failed target is
 * behind a closed menu, dropdown or tab whose trigger is on screen, so the proposal opens the way and
 * the original action must then be retried — only that retry counts as progress. The distinction was
 * measured, not designed: four setups that had to press an item inside a closed account menu got no
 * usable repair at all, because a substitution vocabulary cannot say "click the trigger first", and
 * the honest answers left were `none` or a mechanically-successful click that the runner then wrongly
 * booked as the setup step itself.
 */
export interface Repair {
	action: PageAction;
	before: boolean;
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
export function groundAction(
	candidate: PageAction,
	scan: ReconPage,
	clickables: readonly string[] = [],
): PageAction | null {
	if (candidate.kind === "goto") {
		const path = candidate.path.trim().split("#")[0] ?? "";
		if (!path.startsWith("/")) return null;
		const linked = scan.links.some((l) => (l.href.trim().split("#")[0] ?? "") === path);
		return linked || path === "/" ? { kind: "goto", path } : null;
	}
	if (candidate.kind === "click") {
		// The markup's declared controls first, then what the browser reports as actually clickable — a
		// `div` marked only by `cursor: pointer` is invisible to the scan and is routinely the very
		// thing the case needs to press.
		const label =
			pickFieldLabel(clickableLabels(scan), [candidate.target]) ?? pickFieldLabel([...clickables], [candidate.target]);
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
	/**
	 * True when the screen leaves no choice: exactly one thing could answer to the target, and it
	 * answers by *starting* with it.
	 *
	 * `normalizedOnly` asks "is it the same name?"; this asks the question that decides whether a
	 * human is needed — "could it have meant anything else?". A sheet writes 이메일 and the app labels
	 * its one email box "이메일을 입력해 주세요."; different strings, so not a normalization, but with a
	 * single candidate that carries the target as its opening it is not a guess either. Measured: the
	 * fill landed, the typed value verified, and the case was still capped at needs_review under a
	 * reason that read "the element could not be found".
	 *
	 * Both halves are load-bearing. Two candidates and it is a choice again (이메일 vs 이메일 인증번호)
	 * — the shape that has answered for the wrong box before. And a target that is merely *inside* a
	 * longer label is a fragment of a different name, not that name with instructions after it:
	 * "생성" is the only match on a page whose one button is "신규 계정 생성", but the case may well
	 * have meant a 생성 button this screen does not have. Korean UI puts the name first and the
	 * instruction after it, which is exactly what the prefix test keeps.
	 */
	unambiguous: boolean;
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
	const hint = normLabel(action.target);
	const candidates = vocabulary.filter((v) => normLabel(v).includes(hint)).length;
	return {
		action: grounded,
		normalizedOnly: normLabel(grounded.target) === normLabel(action.target),
		unambiguous: candidates === 1 && normLabel(grounded.target).startsWith(hint),
	};
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

/**
 * Did the repair merely *open the way* to the action that failed, rather than replace it?
 *
 * `when: "before"` asks the model to declare this, and the model is not reliable about it: measured
 * across runs of the same sheet, the same setup was sometimes answered with the flag (the dialog
 * opened, the real step ran) and sometimes with a bare substitution that booked a username as the
 * step. The screen can settle the question without asking — if the control that could not be found
 * is *now* on screen, the fix uncovered it.
 *
 * Two conditions, both load-bearing:
 *  - the fix must not answer to the failed target itself. That is a rename (a sheet says 저장, the app
 *    paints 저장하기), and retrying it would perform the same action twice — a double submit.
 *  - the screen must positively carry the failed target. Unlike `targetOnScreen`, an unpainted page
 *    answers **false** here: this decision has no patient retry behind it, and on the preparation
 *    ladder a wrong retry turns a completed setup into a dead one.
 */
export function unblockedTheOriginal(failed: PageAction, fix: PageAction, html: string, url: string): boolean {
	if (failed.kind !== "click" && failed.kind !== "fill") return false;
	const fixTarget = fix.kind === "click" || fix.kind === "fill" ? fix.target : "";
	if (fixTarget && pickFieldLabel([fixTarget], [failed.target]) !== null) return false;
	const scan = extractStructure(html, url);
	const labels = [...clickableLabels(scan), ...scan.formFields];
	if (labels.length === 0) return false;
	return pickFieldLabel(labels, [failed.target]) !== null;
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
	'When the failed target is likely inside a closed menu, dropdown, or tab whose trigger IS on the scan, add "when":"before" ' +
	"to your action: your action runs first and the failed action is then retried as written. " +
	"Answer none when the screen cannot serve the intent (wrong page, blocking dialog you cannot name, nothing equivalent) — " +
	"giving up is correct and a wrong guess corrupts the rest of the test. Never invent a label, a field, or a route.";

function describeAction(a: PageAction): string {
	if (a.kind === "goto") return `goto ${a.path}`;
	if (a.kind === "click") return `click "${a.target}"`;
	if (a.kind === "fill") return `fill "${a.target}" with "${a.value}"`;
	return a.kind;
}

/**
 * Ask the model for a grounded repair. Returns null when the model declines, replies with garbage,
 * names anything the live page does not actually have, or offers to leave the case.
 */
export async function repairAction(model: ModelClient, req: RepairRequest): Promise<Repair | null> {
	const scan = extractStructure(req.html, req.url);
	const intent = [
		req.title ? `CASE: ${req.title}` : "",
		req.steps?.length ? `STEPS:\n${req.steps.map((s) => `- ${s}`).join("\n")}` : "",
		req.expected ? `EXPECTED: ${req.expected}` : "",
	]
		.filter(Boolean)
		.join("\n");
	// The browser's own list of what a click reaches, alongside the markup scan. It carries the
	// controls the scan structurally cannot see, and it is the vocabulary grounding checks the answer
	// against — so naming one is the model's cheapest way to be accepted.
	const rendered = renderPageForPrompt(scan);
	const alsoClickable = (req.clickables ?? []).filter((c) => !rendered.includes(c));
	const text =
		`${intent ? `${intent}\n\n` : ""}FAILED ACTION: ${describeAction(req.action)}\nERROR: ${req.error}\n\nLIVE PAGE SCAN:\n${rendered}` +
		(alsoClickable.length ? `\nALSO CLICKABLE (reported by the browser): ${alsoClickable.join(" | ")}` : "");
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
	const grounded = candidate ? groundAction(candidate, scan, req.clickables ?? []) : null;
	if (!grounded || abandonsTheCase(req.action, grounded, { phrases: req.phrases })) return null;
	return { action: grounded, before: obj.when === "before" };
}

/**
 * Would this repair walk out of the case instead of carrying it forward?
 *
 * Grounding proves the control exists; it says nothing about intent. Measured over 99 in-run repairs,
 * 12 answered a control the model could not find with the dialog's own way out — a filter answered
 * with 취소, a column header answered with 확인. Both are accepted by grounding and both are wrong in
 * closes or commits, and every later step of the case runs on a screen it never described. A repair
 * that cancels is not a repair, and one that confirms may submit a form the case never meant to send.
 *
 * Only ever a substitution: if the failed action was itself the cancel or the confirm, repairing it to
 * a differently-worded one is exactly right. And clearing a blocking overlay is a different job with
 * its own rung, which runs before a repair is ever asked for.
 */
function abandonsTheCase(
	failed: PageAction,
	repaired: PageAction,
	vocab: { phrases?: Record<string, string[]> } = {},
): boolean {
	if (repaired.kind !== "click") return false;
	const words = { ...DEFAULT_PHRASES, ...(vocab.phrases ?? {}) }.abandonControl ?? [];
	const isExit = (text: string) => {
		const t = normLabel(text);
		return words.some((w) => normLabel(w) === t);
	};
	const from = failed.kind === "click" || failed.kind === "fill" ? failed.target : "";
	return isExit(repaired.target) && !isExit(from);
}
