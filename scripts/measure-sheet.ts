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
const [projectId, sheetId, labelColumn = "검증 결과"] = process.argv.slice(2);

if (!projectId || !sheetId) {
	console.error("usage: measure-sheet.ts <projectId> <sheetId> [labelColumn]");
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
		else if (ev.type === "error") console.error(`  ! ${ev.error}`);
	}
}

// The sheet's own verdict column is the ground truth. Row order survives ingest, so the Nth unique
// case corresponds to the Nth data row.
const { csvText } = await get<{ csvText: string }>(
	`/api/sheet/content?projectId=${encodeURIComponent(projectId)}&sheetId=${encodeURIComponent(sheetId)}`,
);
const rows = parseCsv(csvText);
const header = rows[0] ?? [];
const labelIdx = header.indexOf(labelColumn);
if (labelIdx < 0) {
	throw new Error(`sheet has no "${labelColumn}" column. Columns: ${csvToRawTable(csvText).headers.join(", ")}`);
}
const idIdx = header.indexOf("NO");
const dataRows = rows.slice(1).filter((r) => (idIdx < 0 ? r.some(Boolean) : (r[idIdx] ?? "").trim()));
const labels = new Map<string, { label: string; source: string }>();
ingestCsv(csvText, {}).unique.forEach((c, i) => {
	const row = dataRows[i];
	labels.set(c.caseId, { label: row?.[labelIdx] ?? "", source: (idIdx >= 0 ? row?.[idIdx] : "") ?? "" });
});

interface RunView {
	results: { caseId: string; verdict: ScoreInput["verdict"]; title: string; passed: number; total: number }[];
	counts: Record<string, number>;
	durationMs?: number;
	model?: string;
	reasoning?: string;
	interpreter: string;
}
const history = await get<RunView[]>(
	`/api/history?projectId=${encodeURIComponent(projectId)}&sheetId=${encodeURIComponent(sheetId)}`,
);
const run = history[0];
if (!run) throw new Error("no run recorded");
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
	const id = labels.get(c.caseId)?.source || c.caseId.slice(0, 6);
	console.log(
		`${String(id).padStart(6)}  ${c.human.padEnd(9)} ${c.verdict.padEnd(13)}  ${r?.passed}/${r?.total}` +
			`     ${MARK[c.outcome]?.padEnd(11)}  ${c.holdReason ?? ""}`,
	);
}
console.log(`\n${formatScorecard(card)}`);
if (card.holdsByReason.length > 0) {
	console.log("holds by reason:");
	for (const h of card.holdsByReason) console.log(`  ${String(h.count).padStart(2)}  ${h.reason}`);
}
// The hard gate: a defect a human already found must never come back green.
process.exit(card.falsePass > 0 ? 1 : 0);
