/**
 * `export:e2e <source> --out <dir> [--url <baseUrl>] [--agent-steps]`
 *
 * Turn a QC sheet (Excel, CSV/TSV, or a Google Sheets URL) into a runnable tester-army/e2e suite:
 * <dir>/e2e.config.ts, <dir>/tests/<slug>.e2e.ts, and <dir>/package.json when there is none yet.
 * Prints one summary line per case: deterministic, agent, or held (with its needs_review reason).
 * Exit 0 on success, 2 on a usage or input error.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { csvToRawTable, ingestCsv } from "../intake/ingest.ts";
import { isGoogleSheetUrl, loadSheet } from "../intake/load-sheet.ts";
import { establishRuleFromHeaders } from "../interpret/rule.ts";
import { exportE2E, slugFromSource, suitePackageJson } from "../report/e2e-export.ts";

const USAGE =
	"usage: bun run export:e2e -- <sheet.xlsx|.csv|google-sheet-url> --out <dir> [--url <baseUrl>] [--agent-steps]";

interface Args {
	source: string;
	out: string;
	url?: string;
	agentSteps: boolean;
}

function parseArgs(argv: string[]): Args {
	let source: string | undefined;
	let out: string | undefined;
	let url: string | undefined;
	let agentSteps = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--out") out = argv[++i];
		else if (arg === "--url") url = argv[++i];
		else if (arg === "--agent-steps") agentSteps = true;
		else if (arg === "--") continue;
		else if (arg?.startsWith("--")) throw new Error(`unknown option ${arg}\n${USAGE}`);
		else if (source === undefined) source = arg;
		else throw new Error(`unexpected argument ${arg}\n${USAGE}`);
	}
	if (!source || !out) throw new Error(USAGE);
	if (url !== undefined && !/^https?:\/\/\S+$/.test(url)) throw new Error(`--url must be an http(s) URL: ${url}`);
	return { source, out, url, agentSteps };
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	const sheet = await loadSheet(args.source);
	const rule = establishRuleFromHeaders(csvToRawTable(sheet.csv).headers);
	const { unique } = ingestCsv(sheet.csv);
	if (unique.length === 0) throw new Error(`no test cases found in ${args.source}`);
	const slug = slugFromSource(args.source);
	const { files, summary } = exportE2E(unique, rule, {
		slug,
		baseUrl: args.url,
		agentSteps: args.agentSteps,
		sourceLabel: isGoogleSheetUrl(args.source) ? "a Google Sheet" : basename(args.source),
	});
	for (const file of files) {
		const target = join(args.out, file.path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, file.content, "utf8");
		console.log(`wrote ${target}`);
	}
	const pkg = join(args.out, "package.json");
	if (!existsSync(pkg)) {
		writeFileSync(pkg, suitePackageJson(slug), "utf8");
		console.log(`wrote ${pkg}`);
	}
	for (const entry of summary) {
		const id = entry.sourceId ?? entry.caseId;
		console.log(`${id}  ${entry.mode}${entry.reason ? `  ${entry.reason}` : ""}`);
	}
	const held = summary.filter((s) => s.mode === "held").length;
	console.log(`${summary.length} cases: ${summary.length - held} exported, ${held} held for review`);
	return 0;
}

try {
	process.exitCode = await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 2;
}
