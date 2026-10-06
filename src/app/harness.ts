/**
 * test-osterone as a harness: from whatever the project has — a QC sheet, a 기획서, the code — to a
 * deterministic verdict on the live app, in one command.
 *
 *   QC given  : QC (Excel / CSV / Google Sheets) + 기획서 + code -> 작업시트 (canonical steps) -> run
 *   no QC     : 기획서 + code -> generated QC (canonical steps)                              -> run
 *
 *   node --experimental-strip-types src/app/harness.ts --spec <기획서.md> [--repo <dir>]
 *        [--qc <qc.xlsx | qc.csv | Google Sheets URL>] (--url <app> | --fixture)
 *        [--backend playwright|bsk] [--browser <bsk instance>] [--out <dir>] [--export-e2e]
 *
 * Each stage is the standalone CLI of the same name, run as a child process, so the harness adds no
 * behaviour of its own: a stage that refuses (no model, unreadable sheet, incomplete cases) stops the
 * pipeline with that stage's message instead of feeding a guess to the next one. The model is used only
 * to author (generate / 작업시트화); the verdict still comes from the deterministic engine.
 *
 * Exit codes are the run's own (run-sheet): 0 all pass · 1 a fail, error or false pass · 3 held cases
 * need a human · 2 a stage could not run.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ingestCsv } from "../intake/ingest.ts";
import { loadSheet } from "../intake/load-sheet.ts";
import { stepProblem } from "../interpret/qc-generate.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface HarnessArgs {
	spec: string;
	repo?: string;
	qc?: string;
	url?: string;
	fixture: boolean;
	backend: "playwright" | "bsk";
	browser?: string;
	out: string;
	exportE2E: boolean;
}

export interface Stage {
	name: "worksheet" | "generate" | "check" | "run" | "export";
	script: string;
	args: string[];
}

export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): HarnessArgs {
	const args = argv[0] === "--" ? argv.slice(1) : [...argv];
	const flags = new Map<string, string | true>();
	for (let i = 0; i < args.length; i++) {
		const key = args[i] ?? "";
		if (!key.startsWith("--")) throw new UsageError(`unexpected argument: ${key}`);
		const next = args[i + 1];
		if (next === undefined || next.startsWith("--")) flags.set(key, true);
		else {
			flags.set(key, next);
			i++;
		}
	}
	const value = (name: string): string | undefined => {
		const v = flags.get(name);
		if (v === true) throw new UsageError(`${name} needs a value`);
		return v;
	};
	const known = new Set([
		"--spec",
		"--repo",
		"--qc",
		"--url",
		"--fixture",
		"--backend",
		"--browser",
		"--out",
		"--export-e2e",
	]);
	for (const key of flags.keys()) if (!known.has(key)) throw new UsageError(`unknown flag: ${key}`);
	const spec = value("--spec");
	if (!spec) throw new UsageError("--spec <기획서> is required (it grounds both generation and 작업시트화)");
	const url = value("--url");
	const fixture = flags.get("--fixture") === true;
	if (!!url === fixture) throw new UsageError("give exactly one target: --url <app> or --fixture");
	const backend = value("--backend") ?? "playwright";
	if (backend !== "playwright" && backend !== "bsk")
		throw new UsageError(`--backend must be playwright or bsk, not ${backend}`);
	return {
		spec,
		repo: value("--repo"),
		qc: value("--qc"),
		url,
		fixture,
		backend,
		browser: value("--browser"),
		out: value("--out") ?? join(".e2e", "harness"),
		exportE2E: flags.get("--export-e2e") === true,
	};
}

export function planStages(a: HarnessArgs, qcIsCanonical = false): Stage[] {
	const context = [...(a.repo ? ["--repo", a.repo] : [])];
	const stages: Stage[] = [];
	const sheet = a.qc && qcIsCanonical ? a.qc : join(a.out, a.qc ? "worksheet.xlsx" : "generated-qc.xlsx");
	if (a.qc && qcIsCanonical) {
		// Already executable as written: no model, nothing for 작업시트화 to add.
	} else if (a.qc) {
		stages.push({
			name: "worksheet",
			script: "src/app/qc-worksheet.ts",
			args: [a.qc, "--spec", a.spec, ...context, "--out", sheet],
		});
	} else {
		stages.push({
			name: "generate",
			script: "src/app/qc-generate.ts",
			args: ["--spec", a.spec, ...context, "--out", sheet],
		});
	}
	stages.push({ name: "check", script: "src/app/check-sheet.ts", args: [sheet] });
	stages.push({
		name: "run",
		script: "src/app/run-sheet.ts",
		args: [
			sheet,
			...(a.url ? ["--url", a.url] : ["--fixture"]),
			"--backend",
			a.backend,
			...(a.browser ? ["--browser", a.browser] : []),
			"--junit",
			join(a.out, "junit.xml"),
			"--json",
			join(a.out, "results.json"),
		],
	});
	if (a.exportE2E) {
		stages.push({
			name: "export",
			script: "src/app/export-e2e.ts",
			args: [sheet, "--out", join(a.out, "e2e-suite"), ...(a.url ? ["--url", a.url] : [])],
		});
	}
	return stages;
}

/**
 * Which stage exits stop the pipeline. A run's 1 and 3 are verdicts, not failures of the harness: the
 * export after them still describes the same sheet. Anything else from a stage means its output cannot be
 * trusted by the next one.
 */
/** True when every step of every case is already canonical, i.e. the engine runs the QC as written. */
export async function isCanonicalQc(source: string): Promise<boolean> {
	const cases = ingestCsv((await loadSheet(source)).csv).unique;
	return cases.length > 0 && cases.every((tc) => tc.steps.length > 0 && tc.steps.every((step) => !stepProblem(step)));
}

export function stageStops(stage: Stage, code: number): boolean {
	if (stage.name === "run") return code !== 0 && code !== 1 && code !== 3;
	return code !== 0;
}

function runStage(stage: Stage): Promise<number> {
	return new Promise((done) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", join(REPO, stage.script), ...stage.args], {
			stdio: "inherit",
			cwd: process.cwd(),
		});
		child.on("error", () => done(2));
		child.on("exit", (code) => done(code ?? 2));
	});
}

async function main(): Promise<number> {
	let args: HarnessArgs;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (err) {
		if (!(err instanceof UsageError)) throw err;
		console.error(`harness: ${err.message}`);
		return 2;
	}
	mkdirSync(args.out, { recursive: true });
	const log: string[] = [];
	let runCode = 2;
	let canonical = false;
	if (args.qc) {
		try {
			canonical = await isCanonicalQc(args.qc);
		} catch (err) {
			console.error(`harness: cannot read the QC: ${(err as Error).message}`);
			return 2;
		}
		console.log(
			canonical
				? "harness: every QC step is already canonical — running it as written (no model needed)."
				: "harness: the QC has free-language steps — turning it into a 작업시트 first.",
		);
		log.push(canonical ? "작업시트화: skipped (QC already canonical)" : "작업시트화: needed");
	}
	for (const stage of planStages(args, canonical)) {
		console.log(`\n── harness: ${stage.name} ──`);
		const code = await runStage(stage);
		log.push(`${stage.name}: exit ${code}`);
		if (stage.name === "run") runCode = code;
		if (stageStops(stage, code)) {
			console.error(`harness: stage "${stage.name}" exited ${code}; stopping before the next stage.`);
			runCode = 2;
			break;
		}
	}
	const report = [
		"# test-osterone harness run",
		"",
		`- spec: ${args.spec}`,
		`- qc: ${args.qc ?? "(none — generated from the spec)"}`,
		`- repo context: ${args.repo ?? "(none)"}`,
		`- target: ${args.url ?? "bundled fixture app"} · backend: ${args.backend}`,
		"",
		...log.map((line) => `- ${line}`),
		"",
		`exit: ${runCode}`,
	].join("\n");
	writeFileSync(join(args.out, "harness-report.md"), `${report}\n`);
	console.log(`\nharness: report written to ${join(args.out, "harness-report.md")} (exit ${runCode})`);
	return runCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	// exitCode, not exit(): exiting while a child's pipes are still closing trips a libuv assertion on Windows.
	main().then((code) => {
		process.exitCode = code;
	});
}
