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
 * `labelColumn` defaults to `검증 결과`. Cases whose label is NT/NA/blank are reported separately
 * rather than counted as agreement.
 */

import { csvToRawTable } from "../src/intake/ingest.ts";
import { parseCsv } from "../src/intake/csv.ts";
import { ingestCsv } from "../src/intake/ingest.ts";
import { formatScorecard, scoreAgainstLabels, type ScoreInput } from "../src/report/label-scorecard.ts";

const BASE = process.env.STUDIO_URL?.replace(/\/$/, "") || "http://localhost:8686";
const argv = process.argv.slice(2);
/** Score the run already in history instead of running again — a 15-minute run should not be repeated to re-score it. */
const scoreOnly = argv.includes("--score-only");
const [projectId, sheetId, labelColumn = "검증 결과"] = argv.filter((a) => !a.startsWith("--"));

if (!projectId || !sheetId) {
	console.error("usage: measure-sheet.ts <projectId> <sheetId> [labelColumn] [--score-only]");
	process.exit(2);
}

const get = async <T>(path: string): Promise<T> => {
	const r = await fetch(`${BASE}${path}`);
	if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`);
	return (await r.json()) as T;
};

interface Project {
	id: string;
	sheets: { id: string; name: string; kind: string; sheetUrl: string; csvText: string }[];
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

// Run it. The server hydrates the sheet content from disk, so csvText stays empty on the wire.
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
		sheets: [{ ...sheet, csvText: "" }],
		baseUrl: project.baseUrl,
		env: project.env,
		accounts: project.accounts,
		referenceRepo: project.referenceRepo,
		aiInterpret: project.aiInterpret,
		lenientMatch: project.lenientMatch,
	}),
	});
	if (!res.ok || !res.body) throw new Error(`POST /api/run -> ${res.status} ${await res.text()}`);

	let buf = "";
	for await (const chunk of res.body) {
		buf += Buffer.from(chunk as Uint8Array).toString("utf8");
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

/**
 * The sheet's own verdict column is the ground truth — so a case has to be paired with *its* row.
 *
 * This used to pair the Nth unique case with the Nth data row, on the assumption that row order
 * survives ingest. It does not: ingest drops content-duplicate rows. On the sheet measured here 100
 * rows produced 98 cases, and from the first duplicate onward every pairing slid — 24 of 98 cases were
 * scored against another case's verdict. Every aggregate built on that was wrong by a quarter.
 *
 * So pair by the sheet's own id (`sourceId`, from the NO/ID column), and refuse to fall back to index
 * pairing when the counts differ, because then it is known to be wrong rather than merely unverified.
 */
const { csvText } = await get<{ csvText: string }>(
	`/api/sheet/content?projectId=${encodeURIComponent(projectId)}&sheetId=${encodeURIComponent(sheetId)}`,
);
const rows = parseCsv(csvText);
const header = rows[0] ?? [];
const labelIdx = header.indexOf(labelColumn);
if (labelIdx < 0) {
	throw new Error(`sheet has no "${labelColumn}" column. Columns: ${csvToRawTable(csvText).headers.join(", ")}`);
}
const idIdx = header.findIndex((h) => ["no", "no.", "id", "시험 id", "tc id"].includes(h.toLowerCase().trim()));
// The human's own words for the defect. Printed on every mismatch row because they adjudicate it:
// a false-pass whose 비고 says "기획서와 상이" is the engine judging the sheet while the human judged a
// document the engine has never seen — a documented class, not a defect — and telling the two apart
// used to cost a per-case archaeology dig into the sheet.
const noteIdx = header.findIndex((h) => ["비고", "note", "notes", "remark", "remarks"].includes(h.toLowerCase().trim()));
const dataRows = rows.slice(1).filter((r) => (idIdx < 0 ? r.some(Boolean) : (r[idIdx] ?? "").trim()));
const unique = ingestCsv(csvText, {}).unique;
const labels = new Map<string, { label: string; source: string; note: string }>();
const bySourceId = new Map<string, string[]>();
if (idIdx >= 0) {
	for (const row of dataRows) {
		const id = (row[idIdx] ?? "").trim();
		if (id) bySourceId.set(id, row);
	}
}
const pairedById = idIdx >= 0 && unique.every((c) => c.sourceId && bySourceId.has(c.sourceId));
if (!pairedById && unique.length !== dataRows.length) {
	throw new Error(
		`cannot pair cases with their labels: ${unique.length} cases vs ${dataRows.length} rows and no usable id column. ` +
			`Ingest deduplicates, so index pairing would score cases against other cases' verdicts.`,
	);
}
unique.forEach((c, i) => {
	const row = (pairedById && c.sourceId ? bySourceId.get(c.sourceId) : dataRows[i]) as string[] | undefined;
	labels.set(c.caseId, {
		label: row?.[labelIdx] ?? "",
		source: (idIdx >= 0 ? row?.[idIdx] : "") ?? "",
		note: (noteIdx >= 0 ? row?.[noteIdx] : "")?.replace(/\s+/g, " ").trim() ?? "",
	});
});
console.log(`labels paired by ${pairedById ? "sheet id" : "row order"} · ${unique.length} cases / ${dataRows.length} rows`);

interface RunView {
	results: { caseId: string; verdict: ScoreInput["verdict"]; title: string; passed: number; total: number }[];
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
const queue = await get<{ caseId: string; reason: string }[] | { queue: { caseId: string; reason: string }[] }>(
	`/api/review/queue?projectId=${encodeURIComponent(projectId)}&sheetId=${encodeURIComponent(sheetId)}`,
);
const items = Array.isArray(queue) ? queue : (queue.queue ?? []);
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
		(c.outcome === "false-pass" || c.outcome === "false-fail") && entry?.note ? ` · 비고: ${entry.note.slice(0, 60)}` : "";
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
