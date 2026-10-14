/**
 * Demonstrate a flow once in a real browser, get a runnable QC case.
 *
 *   record-case --out <qc.xlsx|qc.csv> [--url <baseUrl>] [--title ...] [--id ...] [--trace <trace.json|dir>] [--browser <id>]
 *
 * Without --trace it runs `bsk record start --json`, which opens a BrowserSkill Agent Window and blocks
 * until the tester clicks Finish in the browser; the written bundle is then converted and appended.
 * Exit 0: row appended; 2: no trace or unusable input.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { appendCaseToSheet, loadTraceBundle, traceToCase } from "../intake/bsk-trace.ts";

const USAGE =
	"usage: record-case --out <qc.xlsx|qc.csv> [--url <baseUrl>] [--title <title>] [--id <id>] [--trace <trace.json|dir>] [--browser <id>]";

function record(opts: { url?: string; title?: string; browser?: string }): { dir: string; notes: string[] } {
	const dir = mkdtempSync(join(tmpdir(), "bsk-record-"));
	const args = ["record", "start", "--json", "--output", dir];
	if (opts.browser) args.push("--browser", opts.browser);
	if (opts.url) args.push("--url", opts.url);
	if (opts.title) args.push("--purpose", opts.title);
	console.error(`recording: demonstrate the flow in the browser window, then click Finish there (bundle: ${dir})`);
	const run = spawnSync("bsk", args, { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8" });
	if (run.error) throw new Error(`could not run bsk: ${run.error.message}`);
	const notes: string[] = [];
	if (!existsSync(join(dir, "trace.json"))) {
		throw new Error(`bsk record start exited ${run.status} without writing a trace: ${run.stdout.trim()}`);
	}
	// The bundle is committed before session teardown, so a teardown error does not invalidate it.
	if (run.status !== 0) notes.push(`bsk record start exited ${run.status} after writing the trace`);
	return { dir, notes };
}

function main(): number {
	const { values } = parseArgs({
		options: {
			out: { type: "string" },
			url: { type: "string" },
			title: { type: "string" },
			id: { type: "string" },
			trace: { type: "string" },
			browser: { type: "string" },
		},
		strict: true,
	});
	if (!values.out) throw new Error(USAGE);
	const recorded = values.trace ? { dir: values.trace, notes: [] } : record(values);
	const { trace, stateBodies } = loadTraceBundle(recorded.dir);
	const row = traceToCase(trace, { baseUrl: values.url, title: values.title, id: values.id, stateBodies });
	const warnings = [...recorded.notes, ...row.warnings];
	const sheet = appendCaseToSheet(values.out, row);
	for (const warning of warnings) console.error(`warning: ${warning}`);
	console.log(JSON.stringify({ sheet, row: { ...row, warnings } }, null, 2));
	return 0;
}

try {
	process.exitCode = main();
} catch (error) {
	console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
	process.exitCode = 2;
}
