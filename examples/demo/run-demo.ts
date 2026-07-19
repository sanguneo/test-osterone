/**
 * Live end-to-end demo for test-osterone.
 *
 * Ingests a CSV of spreadsheet-style test cases, establishes an interpretation
 * rule, then runs each case against a REAL headless Chromium browser pointed at
 * a bundled fixture app. It prints per-case verdicts, then reruns the whole set
 * to prove determinism (identical verdicts) and that the deterministic engine
 * never emits a false pass.
 *
 *   bun run examples/demo/run-demo.ts            # bundled fixture app
 *   bun run examples/demo/run-demo.ts --headed   # show the browser window
 *
 * Adapt it to your own site: edit cases.csv and set DEMO_BASE_URL to your app.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserPage } from "../../src/execute/browser-page.ts";
import { determinismView, runScenario, type StructuredResult } from "../../src/execute/runner.ts";
import { csvToRawTable, ingestCsv } from "../../src/intake/ingest.ts";
import type { NormalizedTC } from "../../src/intake/schema.ts";
import { MemoryAssertionCache } from "../../src/interpret/assertion.ts";
import { establishRuleFromHeaders, type InterpretationRule } from "../../src/interpret/rule.ts";
import { startFixture } from "../../src/testing/fixture-app.ts";

const here = dirname(fileURLToPath(import.meta.url));
function flagValue(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i !== -1 ? process.argv[i + 1] : undefined;
}

const headed = process.argv.includes("--headed");
const externalUrl = (flagValue("--url") ?? process.env.DEMO_BASE_URL)?.replace(/\/$/, "");
const casesPath = flagValue("--cases") ?? process.env.DEMO_CASES;

function pad(s: string, n: number): string {
	return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

async function runPass(
	baseUrl: string,
	cases: NormalizedTC[],
	rule: InterpretationRule,
	cache: MemoryAssertionCache,
): Promise<StructuredResult[]> {
	const page = await BrowserPage.create({ baseUrl, headless: !headed, timeoutMs: 2000 });
	try {
		const out: StructuredResult[] = [];
		for (const tc of cases) {
			out.push(
				await runScenario(tc, {
					page,
					rule,
					cache,
					env: { browser: "chromium", viewport: "1280x800", baseUrl },
				}),
			);
		}
		return out;
	} finally {
		await page.close();
	}
}

async function main(): Promise<number> {
	const csv = readFileSync(casesPath ?? join(here, "../../src/testing/sample-cases.csv"), "utf8");
	const { unique: cases, duplicates } = ingestCsv(csv);
	const rule = establishRuleFromHeaders(csvToRawTable(csv).headers);
	const cache = new MemoryAssertionCache();
	const titleById = new Map(cases.map((c) => [c.caseId, c.title]));

	const fixture = externalUrl ? null : await startFixture();
	const baseUrl = externalUrl ?? fixture?.url ?? "";

	console.log(`test-osterone — live ${externalUrl ? "run" : "demo"} (real headless Chromium)`);
	console.log(`target : ${baseUrl}${externalUrl ? " (external)" : " (bundled fixture app)"}`);
	console.log(`cases  : ${cases.length} unique${duplicates.length ? `, ${duplicates.length} deduped` : ""}\n`);

	try {
		const first = await runPass(baseUrl, cases, rule, cache);
		const second = await runPass(baseUrl, cases, rule, cache);

		console.log(`${pad("case", 42)}${pad("verdict", 15)}${pad("conf", 6)}${pad("assert", 8)}heal`);
		console.log("-".repeat(78));
		for (const r of first) {
			const passed = r.assertions.filter((a) => a.passed).length;
			const heal = r.healEvents[0] ? (r.healEvents[0].split(":")[0] ?? "yes") : "-";
			console.log(
				pad(titleById.get(r.caseId) ?? r.caseId, 42) +
					pad(r.verdict, 15) +
					pad(r.confidence.toFixed(2), 6) +
					pad(`${passed}/${r.assertions.length}`, 8) +
					heal,
			);
		}

		let identical = 0;
		for (let i = 0; i < first.length; i++) {
			const a = first[i];
			const b = second[i];
			if (a && b && JSON.stringify(determinismView(a)) === JSON.stringify(determinismView(b))) identical++;
		}
		const falsePass = first.some(
			(r) => r.verdict === "pass" && (r.healEvents.length > 0 || r.assertions.some((a) => !a.passed)),
		);

		console.log("-".repeat(78));
		const counts = first.reduce<Record<string, number>>((acc, r) => {
			acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
			return acc;
		}, {});
		console.log(`verdicts     : ${JSON.stringify(counts)}`);
		console.log(
			`determinism  : ${identical}/${first.length} identical on rerun ${identical === first.length ? "OK" : "FAIL"}`,
		);
		console.log(`false-pass   : ${falsePass ? "DETECTED" : "0 OK"}`);

		return identical === first.length && !falsePass ? 0 : 1;
	} finally {
		fixture?.stop();
	}
}

main().then((code) => process.exit(code));
