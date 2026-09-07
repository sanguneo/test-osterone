/**
 * Score a live run against the human verdicts already recorded in a sheet.
 *
 * The engine's own gate (`report/benchmark.ts`) proves determinism against a fixture model without a
 * browser or a model. It cannot tell you whether the engine agrees with a person about a real app —
 * and the number that decides whether this tool is usable is **false-pass**: a case QA filed as a
 * defect that the engine called green.
 *
 * Usage (Studio must be running — it owns the model connection, accounts and browser):
 *
 *   node --experimental-transform-types scripts/measure-sheet.ts <projectId> <sheetId> [labelColumn]
 *
 * `labelColumn` defaults to the saved mapping or detected verdict column. NT/NA/blank are reported separately
 * rather than counted as agreement.
 */

import { csvToRawTable, ingestCsv, mapColumns, toCsvExportUrl } from "../src/intake/ingest.ts";
import type { TcField } from "../src/intake/schema.ts";
import {
	formatScorecard,
	labelsByCase,
	parseHumanVerdict,
	requireCompleteRun,
	type ScoreInput,
	scoreAgainstLabels,
} from "../src/report/label-scorecard.ts";

const BASE = process.env.STUDIO_URL?.replace(/\/$/, "") || "http://localhost:8686";
const argv = process.argv.slice(2);
/** Score the run already in history instead of running again — a 15-minute run should not be repeated to re-score it. */
const scoreOnly = argv.includes("--score-only");
/** `--lanes N`: run the ledger-cleared cases across N browsers. Serial by default — a parallel run is
 * only meaningful compared against one. */
const lanes = Math.max(1, Math.trunc(Number(argv.find((a) => a.startsWith("--lanes="))?.split("=")[1] ?? 1)) || 1);
const [projectId, sheetId, labelColumn] = argv.filter((a) => !a.startsWith("--"));

if (!projectId || !sheetId) {
	console.error("usage: measure-sheet.ts <projectId> <sheetId> [labelColumn] [--score-only] [--lanes=N]");
	process.exit(2);
}

const get = async <T>(path: string): Promise<T> => {
	const r = await fetch(`${BASE}${path}`);
	if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`);
	return (await r.json()) as T;
};

interface Project {
	id: string;
	sheets: {
		id: string;
		name: string;
		kind: string;
		sheetUrl: string;
		csvText: string;
		mapping?: Partial<Record<TcField, string>>;
	}[];
	baseUrl?: string;
	env?: string;
	accounts?: unknown[];
	referenceRepo?: string;
	aiInterpret?: boolean;
	lenientMatch?: boolean;
}

const projects = await get<Project[]>("/api/projects");
const project = projects.find((p) => p.id === projectId);
if (!project) throw new Error(`no project ${projectId}`);
const sheet = project.sheets.find((s) => s.id === sheetId);
if (!sheet) throw new Error(`no sheet ${sheetId} in ${projectId}`);

// Freeze the source text before executing: labels and execution must use the same records.
const state = await get<{ mapping: Partial<Record<TcField, string>> }>(
	`/api/status?projectId=${encodeURIComponent(projectId)}&sheetId=${encodeURIComponent(sheetId)}`,
);
let csvText: string;
if (sheet.kind === "sheet") {
	const source = await fetch(toCsvExportUrl(sheet.sheetUrl));
	if (!source.ok) throw new Error(`sheet fetch failed: ${source.status}`);
	csvText = await source.text();
} else {
	({ csvText } = await get<{ csvText: string }>(
		`/api/sheet/content?projectId=${encodeURIComponent(projectId)}&sheetId=${encodeURIComponent(sheetId)}`,
	));
}
const table = csvToRawTable(csvText);
const overrides = Object.fromEntries(
	Object.entries({ ...state.mapping, ...sheet.mapping }).filter(([, header]) => table.headers.includes(header)),
);
const mapping = { ...mapColumns(table.headers), ...overrides };
const verdictColumn = labelColumn ?? mapping.recordedVerdict;
if (!verdictColumn || !table.headers.includes(verdictColumn)) {
	throw new Error(`No usable verdict column. Columns: ${table.headers.join(", ")}`);
}
const ingested = ingestCsv(csvText, { ...mapping, recordedVerdict: verdictColumn });
const unique = ingested.unique;
const labels = labelsByCase(ingested.all);
if (![...labels.values()].some((entry) => parseHumanVerdict(entry.label) !== "unlabeled")) {
	throw new Error("No recorded Pass/Fail labels are available for comparison.");
}
console.log(`labels paired by normalized case identity: ${unique.length} cases / ${ingested.all.length} records`);

// Run the same source snapshot used to pair the recorded labels.
// `startedAt` is the guard against scoring the wrong thing: a run that dies (the batch aborted on a
// login timeout, the browser never launched) records nothing, and the history's newest entry is then
// yesterday's. Scoring that silently is how a stale run gets reported as today's measurement — it
// happened, and the numbers looked plausible enough to believe.
const startedAt = Date.now();
let runError = "";
if (!scoreOnly) {
	const res = await fetch(`${BASE}/api/run`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			projectId,
			sheetId,
			sheets: [{ ...sheet, kind: "csv", csvText, mapping: { ...mapping, recordedVerdict: verdictColumn } }],
			baseUrl: project.baseUrl,
			env: project.env,
			accounts: project.accounts,
			referenceRepo: project.referenceRepo,
			aiInterpret: project.aiInterpret,
			lenientMatch: project.lenientMatch,
			// `--lanes N` runs the cases a previous run observed not writing to the app across N browsers.
			// Off unless asked for, because a measurement is only worth anything against a serial baseline.
			...(lanes > 1 ? { lanes } : {}),
		}),
	});
	if (!res.ok || !res.body) throw new Error(`POST /api/run -> ${res.status} ${await res.text()}`);

	let buf = "";
	const decoder = new TextDecoder();
	for await (const chunk of res.body) {
		buf += decoder.decode(chunk, { stream: true });
		const lines = buf.split("\n");
		buf = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			let ev: Record<string, unknown>;
			try {
				ev = JSON.parse(line);
			} catch {
				continue;
			}
			if (ev.type === "start") console.log(`run: ${ev.total} cases · ${ev.baseUrl} · ${ev.interpreter}`);
			else if (ev.type === "notice") console.log(`  · ${ev.message}`);
			else if (ev.type === "error") {
				runError = String(ev.error ?? "");
				console.error(`  ! ${runError}`);
			}
		}
	}
}

interface RunView {
	results: {
		caseId: string;
		verdict: ScoreInput["verdict"];
		title: string;
		passed: number;
		total: number;
		assertions?: { detail: string; passed: boolean }[];
	}[];
	counts: Record<string, number>;
	durationMs?: number;
	model?: string;
	reasoning?: string;
	interpreter: string;
	/** Epoch ms the run was recorded — the only way to tell today's run from yesterday's. */
	at?: number;
}
const history = await get<RunView[]>(
	`/api/history?projectId=${encodeURIComponent(projectId)}&sheetId=${encodeURIComponent(sheetId)}`,
);
const run = history[0];
if (!run) throw new Error("no run recorded");
if (runError) throw new Error(`Run failed: ${runError}`);
requireCompleteRun(
	unique.map((tc) => tc.caseId),
	run.results,
);
// The run we just asked for has to be the run we score. A batch that aborts records nothing, and the
// newest history entry is then whatever ran last time — plausible numbers for the wrong code.
if (!scoreOnly && (run.at ?? 0) < startedAt) {
	const age = ((Date.now() - (run.at ?? 0)) / 3600000).toFixed(1);
	throw new Error(
		`this run recorded nothing — the newest history entry is ${age}h old, so scoring it would report the previous run's numbers.` +
			`${runError ? `\n  run error: ${runError}` : ""}` +
			"\n  Fix the run first, or pass --score-only to score the stored run on purpose.",
	);
}
const items = await get<{ caseId: string; reason: string }[]>(
	`/api/review/queue?projectId=${encodeURIComponent(projectId)}&sheetId=${encodeURIComponent(sheetId)}`,
);
const reasonOf = new Map(items.map((i) => [i.caseId, i.reason]));

const card = scoreAgainstLabels(
	run.results.map((r) => ({
		caseId: r.caseId,
		verdict: r.verdict,
		human: labels.get(r.caseId)?.label,
		holdReason: reasonOf.get(r.caseId),
	})),
);

const MARK: Record<string, string> = {
	agree: "agree",
	"false-pass": "FALSE-PASS",
	"false-fail": "false-fail",
	disagree: "disagree",
	held: "held",
	unlabeled: "unlabeled",
};
console.log(
	`\ninterpreter ${run.interpreter}${run.model ? ` · ${run.model}` : ""}${run.reasoning ? ` · ${run.reasoning}` : ""}` +
		`${run.durationMs ? ` · ${(run.durationMs / 1000).toFixed(0)}s` : ""}`,
);
console.log("\n  case  human   engine         checks  outcome      hold reason");
for (const c of card.cases) {
	const r = run.results.find((x) => x.caseId === c.caseId);
	const entry = labels.get(c.caseId);
	const id = entry?.source || c.caseId.slice(0, 6);
	// A mismatch row carries the human's own defect note — it adjudicates the row on the spot.
	const note =
		(c.outcome === "false-pass" || c.outcome === "false-fail") && entry?.note
			? ` · 비고: ${entry.note.slice(0, 60)}`
			: "";
	// A row the human passed carries no defect note, so a false-fail needs the other half of the
	// argument: what the engine looked for and did not find. Measured (NO 216): the sheet quotes one
	// guidance line and the app paints a different one — sheet↔app copy drift, the mirror of the
	// false-pass "기획서와 상이" class, and unreadable from the outcome column alone.
	const missed =
		c.outcome === "false-fail"
			? ` · ${(r?.assertions ?? [])
					.filter((a) => !a.passed)
					.map((a) => a.detail)
					.join(" / ")
					.replace(/\s+/g, " ")
					.slice(0, 90)}`
			: "";
	console.log(
		`${String(id).padStart(6)}  ${c.human.padEnd(9)} ${c.verdict.padEnd(13)}  ${r?.passed}/${r?.total}` +
			`     ${MARK[c.outcome]?.padEnd(11)}  ${c.holdReason ?? ""}${note}${missed}`,
	);
}
console.log(`\n${formatScorecard(card)}`);
if (card.holdsByReason.length > 0) {
	console.log("holds by reason:");
	for (const h of card.holdsByReason) console.log(`  ${String(h.count).padStart(2)}  ${h.reason}`);
}
// The hard gate: a defect a human already found must never come back green.
process.exit(card.falsePass > 0 ? 1 : 0);
