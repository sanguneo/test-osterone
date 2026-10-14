/**
 * Headless sheet runner: take a QC sheet (Excel workbook, CSV/TSV export or Google Sheets URL), run every
 * unique case through the deterministic engine on a real browser, and exit with a code CI can act on.
 *
 *   node --experimental-strip-types src/app/run-sheet.ts <source> (--url <baseUrl> | --fixture)
 *     [--backend playwright|bsk] [--browser <bsk instance>] [--headed] [--junit <file>] [--json <file>]
 *   bun run run:sheet -- <source> --fixture --junit .e2e/junit.xml
 *
 * Backends: `playwright` (default) launches its own Chromium; `bsk` drives the user's real browser through
 * BrowserSkill (`--browser`, or the `BSK_BROWSER` environment variable, picks the instance when more than one is
 * online). `--fixture` serves the
 * bundled login demo app and points the run at it.
 *
 * Exit codes:
 *   0  every case passed
 *   1  any case failed or errored, or a false pass was detected (a pass carrying a failed assertion or a
 *      heal event) — the engine's one unforgivable outcome
 *   3  nothing failed, but at least one case is needs_review: held cases need a human before this is green
 *   2  no verdict was produced: bad flags, an unreadable sheet, a sheet with zero cases, or a browser / bsk
 *      session that could not start (an environment failure must never read as a failed case)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserPage } from "../execute/browser-page.ts";
import { BskPage } from "../execute/bsk-page.ts";
import { runScenario, type StructuredResult } from "../execute/runner.ts";
import { csvToRawTable, ingestCsv } from "../intake/ingest.ts";
import { loadSheet } from "../intake/load-sheet.ts";
import type { NormalizedTC } from "../intake/schema.ts";
import { MemoryAssertionCache } from "../interpret/assertion.ts";
import { establishRuleFromHeaders } from "../interpret/rule.ts";
import { toJUnitXml } from "../report/junit.ts";
import { type Fixture, startFixture } from "../testing/fixture-app.ts";

export const USAGE =
	"usage: run:sheet <file.xlsx|file.csv|Google Sheets URL> (--url <baseUrl> | --fixture) [--backend playwright|bsk] [--browser <bsk instance>] [--headed] [--junit <file>] [--json <file>]";

export type Backend = "playwright" | "bsk";

export interface RunSheetArgs {
	source: string;
	url?: string;
	fixture: boolean;
	backend: Backend;
	browser?: string;
	headed: boolean;
	junit?: string;
	json?: string;
}

/** A bad invocation or unreadable input: always exit 2. */
export class UsageError extends Error {}

const VALUE_FLAGS = new Set(["--url", "--backend", "--browser", "--junit", "--json"]);
const BOOL_FLAGS = new Set(["--fixture", "--headed"]);

/** Parse argv after the script path. A bare "--" (from `bun run x -- ...`) is ignored wherever it appears. */
export function parseArgs(argv: readonly string[]): RunSheetArgs {
	const values: Record<string, string> = {};
	const bools = new Set<string>();
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--") continue;
		if (VALUE_FLAGS.has(arg)) {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value`);
			values[arg] = value;
			i++;
		} else if (BOOL_FLAGS.has(arg)) bools.add(arg);
		else if (arg.startsWith("--")) throw new UsageError(`unknown flag ${arg}`);
		else positional.push(arg);
	}
	if (positional.length !== 1)
		throw new UsageError(positional.length ? "exactly one sheet source" : "missing <source>");
	const fixture = bools.has("--fixture");
	const url = values["--url"]?.replace(/\/+$/, "");
	if (fixture === (url !== undefined)) throw new UsageError("give exactly one of --url <baseUrl> or --fixture");
	if (url !== undefined && !URL.canParse(url)) throw new UsageError(`--url is not a URL: ${url}`);
	const backend = values["--backend"] ?? "playwright";
	if (backend !== "playwright" && backend !== "bsk") throw new UsageError(`--backend must be playwright or bsk`);
	if (values["--browser"] !== undefined && backend !== "bsk")
		throw new UsageError("--browser applies to --backend bsk");
	if (bools.has("--headed") && backend !== "playwright")
		throw new UsageError("--headed applies to --backend playwright");
	return {
		source: positional[0] ?? "",
		url,
		fixture,
		backend,
		browser: values["--browser"],
		headed: bools.has("--headed"),
		junit: values["--junit"],
		json: values["--json"],
	};
}

/** Passes that are not proven: a failed assertion or any heal event under a `pass`. Returns their case ids. */
export function falsePasses(results: readonly StructuredResult[]): string[] {
	return results
		.filter((r) => r.verdict === "pass" && (r.healEvents.length > 0 || r.assertions.some((a) => !a.passed)))
		.map((r) => r.caseId);
}

/** The exit code for a completed run (see the header). Zero cases is an input error, decided before running. */
export function exitCodeFor(results: readonly StructuredResult[]): number {
	if (results.length === 0) return 2;
	if (falsePasses(results).length > 0) return 1;
	if (results.some((r) => r.verdict === "fail" || r.verdict === "error")) return 1;
	if (results.some((r) => r.verdict === "needs_review")) return 3;
	return 0;
}

function pad(s: string, n: number): string {
	return s.length >= n ? `${s.slice(0, n - 1)} ` : s + " ".repeat(n - s.length);
}

/** The printed report: one row per case, then verdict counts and the false-pass check. */
export function formatReport(results: readonly StructuredResult[], cases: readonly NormalizedTC[]): string {
	const byId = new Map(cases.map((c) => [c.caseId, c]));
	const lines = [`${pad("sourceId", 12)}${pad("title", 40)}${pad("verdict", 14)}${pad("assert", 8)}heal`];
	lines.push("-".repeat(80));
	for (const r of results) {
		const tc = byId.get(r.caseId);
		const passed = r.assertions.filter((a) => a.passed).length;
		const heal = r.healEvents[0] ? (r.healEvents[0].split(":")[0] ?? "yes") : "-";
		lines.push(
			pad(tc?.sourceId ?? r.caseId, 12) +
				pad((tc?.title ?? "").replace(/\s+/g, " "), 40) +
				pad(r.verdict, 14) +
				pad(`${passed}/${r.assertions.length}`, 8) +
				(r.verdict === "error" ? `error: ${(r.errorInfo ?? "").split("\n")[0]}` : heal),
		);
	}
	lines.push("-".repeat(80));
	const counts = results.reduce<Record<string, number>>((acc, r) => {
		acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
		return acc;
	}, {});
	lines.push(`verdicts   : ${JSON.stringify(counts)}`);
	const fp = falsePasses(results);
	lines.push(`false-pass : ${fp.length ? `DETECTED (${fp.join(", ")})` : "0 OK"}`);
	return lines.join("\n");
}

function writeOut(file: string, content: string): void {
	const path = resolve(file);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

async function main(argv: readonly string[]): Promise<number> {
	let args: RunSheetArgs;
	let cases: NormalizedTC[];
	let headers: string[];
	try {
		args = parseArgs(argv);
		const sheet = await loadSheet(args.source);
		cases = ingestCsv(sheet.csv).unique;
		headers = csvToRawTable(sheet.csv).headers;
		if (cases.length === 0) throw new UsageError(`no test cases found in ${args.source}`);
	} catch (error) {
		console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
		if (error instanceof UsageError) console.error(USAGE);
		return 2;
	}

	const rule = establishRuleFromHeaders(headers);
	const cache = new MemoryAssertionCache();
	let fixture: Fixture | null = null;
	let page: BrowserPage | BskPage | null = null;
	try {
		if (args.fixture) fixture = await startFixture();
		const baseUrl = args.url ?? fixture?.url ?? "";
		console.log(`run:sheet  ${args.source}`);
		console.log(`target   : ${baseUrl}${fixture ? " (bundled fixture app)" : ""}`);
		console.log(`backend  : ${args.backend}${args.browser ? ` (${args.browser})` : ""}`);
		console.log(`cases    : ${cases.length} unique\n`);
		page =
			args.backend === "bsk"
				? await BskPage.create({ baseUrl, browser: args.browser ?? process.env.BSK_BROWSER })
				: await BrowserPage.create({ baseUrl, headless: !args.headed, timeoutMs: 4000 });
		const env = { browser: args.backend === "bsk" ? "bsk" : "chromium", viewport: "1280x800", baseUrl };
		const results: StructuredResult[] = [];
		for (const tc of cases) results.push(await runScenario(tc, { page, rule, cache, env }));

		console.log(formatReport(results, cases));
		if (args.junit) {
			writeOut(args.junit, toJUnitXml(results));
			console.log(`junit    : ${args.junit}`);
		}
		if (args.json) {
			writeOut(args.json, `${JSON.stringify(results, null, 2)}\n`);
			console.log(`json     : ${args.json}`);
		}
		const code = exitCodeFor(results);
		console.log(`exit     : ${code}`);
		return code;
	} catch (error) {
		console.error(`run failed: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	} finally {
		await page?.close().catch((error: unknown) => {
			console.error(`page close failed: ${error instanceof Error ? error.message : String(error)}`);
		});
		fixture?.stop();
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then((code) => process.exit(code));
}
