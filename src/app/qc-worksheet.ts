/**
 * qc:worksheet (작업시트화) — a QC written in free natural language -> a work sheet in the canonical grammar.
 *
 *   bun run qc:worksheet -- <sheet.xlsx|.csv|google-sheet-url> [--spec <file>] [--repo <dir>] --out <worksheet.xlsx|.csv>
 *
 * Exit codes: 0 written; 1 written but a model call failed (those rows are held for review); 2 usage error or no
 * model available.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { ingestCsv } from "../intake/ingest.ts";
import { loadSheet } from "../intake/load-sheet.ts";
import { mapColumns } from "../intake/table.ts";
import { digestRepoDir } from "../interpret/repo-recon.ts";
import { toWorksheet, WORKSHEET_HEADERS, writeWorksheet } from "../interpret/worksheet.ts";
import { resolveCliModel } from "../model/cli-model.ts";

const USAGE =
	"usage: bun run qc:worksheet -- <sheet.xlsx|.csv|google-sheet-url> [--spec <file>] [--repo <dir>] --out <worksheet.xlsx|.csv>";

/** Hard bounds on the code context handed to the model. */
const MAX_EXCERPT_FILES = 8;
const MAX_EXCERPT_CHARS = 4000;
const MAX_CONTEXT_CHARS = 24000;

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i !== -1 ? args[i + 1] : undefined;
}

/** Structural digest plus bounded source excerpts, so the model can see the labels the code actually renders. */
function codeContextFor(dir: string): string {
	const digest = digestRepoDir(dir);
	const lines = [`REPO ${digest.name}`];
	if (digest.routes.length) lines.push(`routes: ${digest.routes.join(", ")}`);
	if (digest.components.length) lines.push(`components/pages: ${digest.components.join(", ")}`);
	if (digest.files.length) lines.push(`files: ${digest.files.join(", ")}`);
	for (const rel of digest.files.slice(0, MAX_EXCERPT_FILES)) {
		try {
			lines.push(`--- ${rel}\n${readFileSync(join(dir, rel), "utf8").slice(0, MAX_EXCERPT_CHARS)}`);
		} catch {
			// unreadable file: the digest line above still names it
		}
	}
	return lines.join("\n\n").slice(0, MAX_CONTEXT_CHARS);
}

async function main(args: string[]): Promise<number> {
	const source = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
	const out = flag(args, "--out");
	const specPath = flag(args, "--spec");
	const repo = flag(args, "--repo");
	if (!source || !out) {
		console.error(USAGE);
		return 2;
	}
	if (![".xlsx", ".csv"].includes(extname(out).toLowerCase())) {
		console.error(`--out must end in .xlsx or .csv\n${USAGE}`);
		return 2;
	}
	// The output must read back with steps from 시험절차, never from 원문.
	const mapping = mapColumns([...WORKSHEET_HEADERS]);
	if (mapping.step !== "시험절차") throw new Error(`worksheet header mapping broke: step -> ${mapping.step}`);

	const model = resolveCliModel();
	if (!model) {
		console.error(
			"qc:worksheet needs a model: set OPENAI_API_KEY or sign in to Codex (codex login) — refusing to guess without one.",
		);
		return 2;
	}
	const sheet = await loadSheet(source);
	const { unique: cases } = ingestCsv(sheet.csv);
	if (cases.length === 0) {
		console.error(`no test cases found in ${source}`);
		return 2;
	}
	const spec = specPath ? readFileSync(specPath, "utf8") : undefined;
	const codeContext = repo ? codeContextFor(repo) : undefined;
	console.log(`model  : ${model.label}`);
	console.log(
		`source : ${source} (${cases.length} cases${
			sheet.tabs.length
				? `, tabs ${sheet.tabs
						.filter((t) => t.selected)
						.map((t) => t.name)
						.join(", ")}`
				: ""
		})`,
	);

	const { rows, warnings } = await toWorksheet({ cases, spec, codeContext, model: model.client });
	mkdirSync(dirname(out), { recursive: true });
	writeWorksheet(out, rows);

	for (const row of rows) {
		console.log(`\n${row.sourceId} ${row.title} [${row.status}]`);
		const width = Math.max(row.originalSteps.length, row.steps.length);
		for (let i = 0; i < width; i++) console.log(`  ${row.originalSteps[i] ?? ""}  =>  ${row.steps[i] ?? ""}`);
		console.log(`  근거: ${row.evidence}`);
	}
	for (const w of warnings) console.error(`warning: ${w}`);
	const ok = rows.filter((r) => r.status === "ok").length;
	console.log(`\nwrote ${out}: ${ok}/${rows.length} ok, ${rows.length - ok} needs_review`);
	return warnings.some((w) => w.startsWith("model call failed")) ? 1 : 0;
}

main(process.argv.slice(2)).then(
	// exitCode, not process.exit(): exiting while the model's HTTP handles are still closing trips a libuv
	// assertion on Windows and replaces the real exit code with 9.
	(code) => {
		process.exitCode = code;
	},
	(err) => {
		console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
		process.exitCode = 1;
	},
);
