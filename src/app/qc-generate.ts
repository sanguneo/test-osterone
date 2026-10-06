/**
 * Generate a QC sheet from a 기획서 when no QC exists yet.
 *
 *   bun run qc:generate -- --spec <file.md|.txt> [--repo <dir>] --out <qc.xlsx|qc.csv> [--lang ko|en]
 *
 * Exit 0: sheet written (flagged cases are kept and listed); 1: generation failed; 2: bad arguments or no model.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import { generateQc, toQcCsv, toQcWorkbook } from "../interpret/qc-generate.ts";
import { digestRepoDir } from "../interpret/repo-recon.ts";
import { resolveCliModel } from "../model/cli-model.ts";

const USAGE =
	"usage: bun run qc:generate -- --spec <file.md|.txt> [--repo <dir>] --out <qc.xlsx|qc.csv> [--lang ko|en]";

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i !== -1 ? args[i + 1] : undefined;
}

/** The repo digest as plain text, bounded so a large repo cannot crowd the spec out of the prompt. */
function codeContextOf(dir: string): string {
	const d = digestRepoDir(dir, { maxFiles: 2000, maxRead: 40 });
	const lines = [`repo: ${d.name}`];
	if (d.routes.length) lines.push(`routes: ${d.routes.join(", ")}`);
	if (d.components.length) lines.push(`components/pages: ${d.components.join(", ")}`);
	if (d.scripts.length) lines.push(`scripts: ${d.scripts.join(", ")}`);
	if (d.files.length) lines.push(`files:\n${d.files.slice(0, 80).join("\n")}`);
	if (d.readme) lines.push(`README:\n${d.readme}`);
	return lines.join("\n").slice(0, 8000);
}

function oneLine(s: string, n: number): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

async function main(args: string[]): Promise<number> {
	const specPath = flag(args, "--spec");
	const out = flag(args, "--out");
	const repo = flag(args, "--repo");
	const lang = flag(args, "--lang") ?? "ko";
	if (!specPath || !out) {
		console.error(USAGE);
		return 2;
	}
	if (lang !== "ko" && lang !== "en") {
		console.error(`--lang must be ko or en, got ${lang}`);
		return 2;
	}
	const ext = extname(out).toLowerCase();
	if (ext !== ".xlsx" && ext !== ".csv") {
		console.error(`--out must end in .xlsx or .csv, got ${out}`);
		return 2;
	}
	const model = resolveCliModel();
	if (!model) {
		console.error("no model: set OPENAI_API_KEY or sign in to Codex");
		return 2;
	}
	const spec = readFileSync(specPath, "utf8");
	const specName = basename(specPath);
	const codeContext = repo ? codeContextOf(repo) : undefined;
	console.log(`qc:generate — spec ${specName}${repo ? ` + repo ${repo}` : ""} · model ${model.label}`);

	const result = await generateQc({ spec, specName, codeContext, model: model.client, language: lang });

	mkdirSync(dirname(out), { recursive: true });
	if (ext === ".xlsx") {
		const date = new Date().toISOString().slice(0, 10);
		writeFileSync(out, toQcWorkbook(result.cases, { specName, date, modelLabel: model.label }));
	} else {
		writeFileSync(out, toQcCsv(result.cases), "utf8");
	}

	console.log(`\n${result.cases.length} cases → ${out}\n`);
	for (const c of result.cases) {
		console.log(
			`${c.id} [${c.sourceRef || "-"}] ${c.priority} ${c.category} / ${c.title}${c.note ? "  ⚠ flagged" : ""}`,
		);
		if (c.precondition) console.log(`    사전조건: ${oneLine(c.precondition, 100)}`);
		for (const step of c.steps) console.log(`    ${step}`);
		console.log(`    → ${oneLine(c.expected, 100)}`);
	}
	console.log("\ncoverage:");
	if (result.coverage.length === 0) console.log("  (the spec defines no requirement ids)");
	for (const cov of result.coverage) {
		console.log(`  ${cov.requirement}: ${cov.cases.length ? cov.cases.join(", ") : "NOT COVERED"}`);
	}
	console.log(`\nwarnings: ${result.warnings.length === 0 ? "none" : ""}`);
	for (const w of result.warnings) console.log(`  - ${w}`);
	return 0;
}

main(process.argv.slice(2).filter((a) => a !== "--")).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		console.error(`qc:generate failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	},
);
