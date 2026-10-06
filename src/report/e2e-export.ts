/**
 * Export a QC sheet's cases as a tester-army/e2e suite, so the same cases run on e2e's runner (every
 * browser, viewport, CI reporter) without giving up false-pass = 0.
 *
 * The mapping only emits what the rule engine itself would judge, in the form e2e documents for it:
 * a step the rule cannot parse, a check with no deterministic oracle, or an expected result the
 * authored checks do not cover is emitted *skipped* with a `needs_review:` reason — never as a test
 * that could pass on nothing. `agentSteps` lets `agent.act` drive a step the rule cannot parse, but a
 * verdict still comes only from deterministic `expect` calls, never from `agent.assert`.
 *
 * The generated file also mirrors the engine's vacuity gate: when a case interacts with the page, the
 * screen is read before the first interaction, and a check that already held there skips the test as
 * `needs_review` after the expects pass — a check that was true before the click proves nothing about it.
 *
 * Output is a pure function of the input: no clock, no absolute paths, so two exports are byte-identical.
 */

import type { NormalizedTC } from "../intake/schema.ts";
import type { Assertion } from "../interpret/assertion.ts";
import { authorAssertions, escapeRe, type PageAction, parseStep, requirementCoverage } from "../interpret/interpret.ts";
import type { InterpretationRule } from "../interpret/rule.ts";

export const E2E_VERSION = "0.17.0";
export const E2E_WEB_VERSION = "0.12.0";
export const DEFAULT_APP_URL = "http://127.0.0.1:3000";

export interface ExportE2EOptions {
	/** File stem of the generated test file: `tests/<slug>.e2e.ts`. */
	slug: string;
	/** Fixed app URL for the config; without it the config reads `APP_URL`, then the default. */
	baseUrl?: string;
	/** Let `agent.act` drive steps the rule cannot parse. Verdicts stay deterministic. */
	agentSteps?: boolean;
	/** Human label of the source sheet for the header comment (a file name, not an absolute path). */
	sourceLabel?: string;
}

export type ExportMode = "deterministic" | "agent" | "held";

export interface ExportSummaryEntry {
	caseId: string;
	sourceId: string | null;
	mode: ExportMode;
	reason?: string;
}

export interface ExportE2EResult {
	files: { path: string; content: string }[];
	summary: ExportSummaryEntry[];
}

/** A file-name-safe stem for a sheet path or Google Sheets URL. */
export function slugFromSource(source: string): string {
	const sheetId = source.match(/docs\.google\.com\/spreadsheets\/d\/([\w-]+)/)?.[1];
	const stem = sheetId
		? `gsheet-${sheetId.slice(0, 12)}`
		: (source
				.split(/[\\/]/)
				.pop()
				?.replace(/\.[^.]+$/, "") ?? "");
	const slug = stem
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "qc";
}

/** package.json for a fresh suite directory. */
export function suitePackageJson(slug: string): string {
	const pkg = {
		name: `${slug}-e2e`,
		private: true,
		type: "module",
		scripts: { test: "e2e run" },
		devDependencies: { "@e2e-dev/web": E2E_WEB_VERSION, e2e: E2E_VERSION },
	};
	return `${JSON.stringify(pkg, null, 2)}\n`;
}

const q = (value: string): string => JSON.stringify(value);
const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

/** A case-sensitive substring regex literal; whitespace runs match any whitespace, as e2e normalizes text. */
function textRegex(value: string): string {
	const source = oneLine(value).split(" ").map(escapeRe).join("\\s+");
	return `/${source.replace(/\//g, "\\/")}/`;
}

/**
 * The engine's url check as a regex over the full URL: a path matches itself or a sub-path (the
 * query and hash are ignored), anything else is a plain substring of the URL.
 */
function urlRegex(value: string): string {
	const isPath = value.startsWith("/") && !value.startsWith("//") && !/[?#]/.test(value);
	let source: string;
	if (!isPath) source = escapeRe(value);
	else {
		const path = value.replace(/\/+$/, "") || "/";
		const origin = "^[a-zA-Z][a-zA-Z0-9+.-]*://[^/?#]*";
		source = path === "/" ? `${origin}/?(?:[?#].*)?$` : `${origin}${escapeRe(path)}(?:/[^?#]*)?(?:[?#].*)?$`;
	}
	// escapeRe never emits `\/`, so every `/` here is bare and needs escaping for the literal.
	return `/${source.replace(/\//g, "\\/")}/`;
}

/** The deterministic e2e assertion for one engine assertion, or null when none is faithful. */
export function assertionLine(a: Assertion): string | null {
	if (a.kind === "textIncludes" && a.value.trim())
		return `await expect(screen.getByText(${textRegex(a.value)}, { visible: true }).first()).toBeVisible();`;
	if (a.kind === "textNotIncludes" && a.value.trim())
		return `await expect(screen.getByText(${textRegex(a.value)}, { visible: true }).first()).not.toBeVisible();`;
	if (a.kind === "urlIncludes" && a.value.trim()) return `await expect(browser).toHaveURL(${urlRegex(a.value)});`;
	return null;
}

/** The pre-interaction form of an assertion, read by the generated `heldBefore` vacuity check. */
function checkLiteral(a: Assertion): string {
	if (a.kind === "urlIncludes") return `{ url: ${urlRegex(a.value)} }`;
	if (a.kind === "textNotIncludes") return `{ noText: ${q(a.value)} }`;
	return `{ text: ${q((a as { value: string }).value)} }`;
}

/** The e2e statement for one parsed step; null when the step needs the agent or cannot be expressed. */
export function actionLine(action: PageAction): string | null {
	switch (action.kind) {
		case "goto":
			return action.path ? `await app.open(${q(action.path)});` : null;
		case "fill":
			return action.target ? `await screen.getByLabel(${q(action.target)}).fill(${q(action.value)});` : null;
		case "click": {
			if (!action.target) return null;
			const t = q(action.target);
			return `await tapNamed([screen.getByRole("button", ${t}), screen.getByRole("link", ${t}), screen.getByText(${t})]);`;
		}
		default:
			return null;
	}
}

type Line = { code: string; interaction: boolean } | { comment: string };

interface Planned {
	tc: NormalizedTC;
	title: string;
	mode: ExportMode;
	reason?: string;
	lines: Line[];
	assertions: Assertion[];
}

function hold(tc: NormalizedTC, title: string, why: string): Planned {
	return { tc, title, mode: "held", reason: `needs_review: ${oneLine(why)}`, lines: [], assertions: [] };
}

function planCase(tc: NormalizedTC, title: string, rule: InterpretationRule, agentSteps: boolean): Planned {
	if (tc.steps.length === 0) return hold(tc, title, "the case has no steps");
	if (tc.precondition?.trim())
		return hold(tc, title, `precondition "${tc.precondition}" has no executable preparation`);
	const assertions = authorAssertions(tc, rule);
	const lines: Line[] = [];
	let usedAgent = false;
	for (const [index, step] of tc.steps.entries()) {
		const n = index + 1;
		const action = parseStep(step, rule);
		lines.push({ comment: `${n}. ${oneLine(step)}` });
		if (action.kind === "verify") {
			// A verify step contributes its checks to `assertions`; one with nothing checkable is a hole.
			const own = authorAssertions({ ...tc, steps: [step], expected: "" }, rule);
			if (own.length === 0) return hold(tc, title, `verify step ${n} has no deterministic assertion: "${step}"`);
			continue;
		}
		const code = actionLine(action);
		if (code) {
			lines.push({ code, interaction: action.kind !== "goto" });
			continue;
		}
		if (!agentSteps) return hold(tc, title, `step ${n} cannot be parsed by the rule: "${step}"`);
		usedAgent = true;
		lines.push({ code: `await agent.act(${q(step)});`, interaction: true });
	}
	if (assertions.length === 0) return hold(tc, title, "the expected result has no deterministic assertion");
	const unsupported = assertions.find((a) => assertionLine(a) === null);
	if (unsupported) return hold(tc, title, `a ${unsupported.kind} check has no faithful e2e assertion`);
	const coverage = requirementCoverage(tc.expected, assertions, { phrases: rule.phrases, routes: rule.routes });
	if (coverage && coverage.covered < coverage.total)
		return hold(tc, title, `expected result not covered by any assertion: ${coverage.missing.join(" / ")}`);
	return { tc, title, mode: usedAgent ? "agent" : "deterministic", lines, assertions };
}

/** Comment-safe single line. */
const commentText = (value: string): string => oneLine(value);

function renderHeld(p: Planned): string {
	const out = [`// ${commentText(p.reason ?? "")}`];
	for (const [i, step] of p.tc.steps.entries()) out.push(`// ${i + 1}. ${commentText(step)}`);
	if (p.tc.expected) out.push(`// expected: ${commentText(p.tc.expected)}`);
	out.push(`test(${q(p.title)}, { skip: ${q(p.reason ?? "needs_review")} }, async () => {});`);
	return out.join("\n");
}

function renderCase(p: Planned): string {
	const interactions = p.lines.filter((l) => "code" in l && l.interaction).length;
	const vacuityGate = interactions > 0;
	const needsBrowser = vacuityGate || p.assertions.some((a) => a.kind === "urlIncludes");
	const usesAgent = p.lines.some((l) => "code" in l && l.code.startsWith("await agent."));
	const fixtures = ["app", "screen", ...(needsBrowser ? ["browser"] : []), ...(usesAgent ? ["agent"] : [])];
	const body: string[] = [];
	let seen = 0;
	for (const line of p.lines) {
		if ("comment" in line) {
			body.push(`// ${commentText(line.comment)}`);
			continue;
		}
		if (line.interaction) {
			// Mirror the engine: the baseline is the screen before the first interaction, re-read when an
			// interaction moved to another URL and more interactions follow.
			if (seen === 0) body.push("let before = await readScreen(browser);");
			seen++;
			body.push(line.code);
			if (seen < interactions) body.push("before = await rebase(browser, before);");
			continue;
		}
		body.push(line.code);
	}
	if (p.tc.expected) body.push(`// expected: ${commentText(p.tc.expected)}`);
	for (const a of p.assertions) body.push(assertionLine(a) ?? "");
	if (vacuityGate) {
		body.push(
			`test.skip(heldBefore(before, [${p.assertions.map(checkLiteral).join(", ")}]), ${q(
				"needs_review: a check already held before the first interaction, so it cannot tell what the steps changed",
			)});`,
		);
	}
	return [`test(${q(p.title)}, async ({ ${fixtures.join(", ")} }) => {`, ...body.map((l) => `\t${l}`), "});"].join(
		"\n",
	);
}

const TAP_HELPER = `type Tappable = { count(): Promise<number>; tap(): Promise<void> };

/** Taps the first candidate that matches: button, then link by accessible name, then exact text. */
async function tapNamed(candidates: readonly Tappable[]): Promise<void> {
	const any = async (): Promise<boolean> => {
		for (const candidate of candidates) if ((await candidate.count()) > 0) return true;
		return false;
	};
	await expect.poll(any, { timeout: 30_000, message: "no button, link, or exact text with that name" }).toBe(true);
	for (const candidate of candidates) if ((await candidate.count()) > 0) return candidate.tap();
	throw new Error("the matching control disappeared before it could be tapped");
}`;

const SCREEN_HELPERS = `interface ScreenText {
	url: string;
	text: string;
}

type Check = { text: string } | { noText: string } | { url: RegExp };

async function readScreen(browser: Browser): Promise<ScreenText> {
	return { url: await browser.url(), text: await browser.evaluate<string>("() => document.body.innerText") };
}

async function rebase(browser: Browser, prior: ScreenText): Promise<ScreenText> {
	return (await browser.url()) === prior.url ? prior : readScreen(browser);
}

const squash = (value: string): string => value.replace(/\\s+/g, " ").trim();

/** Did any check already hold on the screen before the first interaction? Then it proves nothing. */
function heldBefore(before: ScreenText, checks: readonly Check[]): boolean {
	const has = (value: string) => squash(before.text).includes(squash(value));
	return checks.some((c) => ("url" in c ? c.url.test(before.url) : "text" in c ? has(c.text) : !has(c.noText)));
}`;

function renderConfig(opts: ExportE2EOptions): string {
	const url = opts.baseUrl ? q(opts.baseUrl) : `process.env.APP_URL ?? ${q(DEFAULT_APP_URL)}`;
	const lines = [
		"// Generated by test-osterone export:e2e. Re-export to update; manual edits are overwritten.",
		'import { web } from "@e2e-dev/web";',
		'import type { E2EConfig } from "e2e";',
		"",
		...(opts.baseUrl
			? []
			: [
					"// Module-scoped, so the config type-checks without @types/node and still agrees with it when present.",
					"declare const process: { readonly env: Readonly<Record<string, string | undefined>> };",
					"",
				]),
		"export default {",
		`\ttargets: [{ name: "web", engine: web(), app: { url: ${url} } }],`,
	];
	if (opts.agentSteps) {
		lines.push(
			"\t// agent.act drives steps the sheet's rule could not parse; verdicts still come only from expect.",
			"\t// Configure a model for the default agent: see node_modules/e2e/docs/subscriptions.mdx",
			"\tagents: { default: {} },",
		);
	}
	lines.push("} satisfies E2EConfig;", "");
	return lines.join("\n");
}

/** Convert normalized QC cases into an e2e suite: a config and one test file, one test per case. */
export function exportE2E(cases: NormalizedTC[], rule: InterpretationRule, opts: ExportE2EOptions): ExportE2EResult {
	const titles = new Map<string, number>();
	const planned = cases.map((tc) => {
		const base = oneLine(`${tc.sourceId ?? tc.caseId} ${tc.title}`) || tc.caseId;
		const count = (titles.get(base) ?? 0) + 1;
		titles.set(base, count);
		const title = count === 1 ? base : `${base} (${count})`;
		return planCase(tc, title, rule, opts.agentSteps === true);
	});
	const runnable = planned.filter((p) => p.mode !== "held");
	const needsTap = runnable.some((p) => p.lines.some((l) => "code" in l && l.code.startsWith("await tapNamed(")));
	const needsScreen = runnable.some((p) => p.lines.some((l) => "code" in l && l.interaction));
	const header = [
		`// Generated by test-osterone export:e2e${opts.sourceLabel ? ` from ${commentText(opts.sourceLabel)}` : ""}.`,
		"// Verdicts come only from deterministic expect calls; a case the engine cannot judge is skipped as needs_review.",
		...(needsScreen ? ['import type { Browser } from "@e2e-dev/web";'] : []),
		'import { test } from "@e2e-dev/web";',
		'import { expect } from "e2e";',
	];
	const sections = [header.join("\n")];
	if (needsTap) sections.push(TAP_HELPER);
	if (needsScreen) sections.push(SCREEN_HELPERS);
	for (const p of planned) sections.push(p.mode === "held" ? renderHeld(p) : renderCase(p));
	const testFile = `${sections.join("\n\n")}\n`;
	return {
		files: [
			{ path: "e2e.config.ts", content: renderConfig(opts) },
			{ path: `tests/${opts.slug}.e2e.ts`, content: testFile },
		],
		summary: planned.map((p) => ({
			caseId: p.tc.caseId,
			sourceId: p.tc.sourceId,
			mode: p.mode,
			...(p.reason ? { reason: p.reason } : {}),
		})),
	};
}
