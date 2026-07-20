/**
 * Durable per-project Studio state. The Studio server keeps one ProjectState per
 * project (interpretation rule, refine chat, plan cache, approved baselines, the
 * needs_review queue, and run history). Everything here lets that state survive a
 * server restart by serializing it to JSON on disk — the projects themselves already
 * persist to studio-projects.json, but their runtime state used to live only in memory.
 *
 * Node-safe on purpose: the engine's SqliteEvidenceStore uses bun:sqlite, which is
 * unavailable under Node (Studio runs on Node because Playwright hangs under Bun on
 * Windows), so persistence here is plain JSON — no native driver, no dual-runtime split.
 *
 * Why the *whole* runtime state and not just the review queue: baselines are keyed by
 * (caseId + ruleVersion + env). If the rule reset on restart, ruleVersion/mapping would
 * change, caseIds would differ, and persisted baselines would never match — so restoring
 * approvals correctly *requires* restoring the rule and plan cache alongside them.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Verdict } from "../../execute/runner.ts";
import { MemoryPlanCache, type PlanCacheEntry } from "../../interpret/author.ts";
import { establishRuleFromHeaders, type InterpretationRule, parseRule } from "../../interpret/rule.ts";
import { type Baseline, MemoryBaselineStore } from "../../judge/baseline.ts";
import type { ModelMessage } from "../../model/model-client.ts";

export interface CaseView {
	caseId: string;
	title: string;
	verdict: Verdict;
	confidence: number;
	passed: number;
	total: number;
	heal: string[];
	assertions: { detail: string; passed: boolean }[];
}

export interface RunView {
	at: number;
	source: string;
	baseUrl: string;
	interpreter: "ai" | "rule";
	counts: Record<Verdict, number>;
	results: CaseView[];
	sheetId: string;
}

export interface ReviewItem {
	caseId: string;
	title: string;
	verdict: Verdict;
	reason: string;
	url: string;
	text: string;
	screenshot?: string;
	ruleVersion: number;
	env: string;
	sheetId: string;
}

/** Per-sheet runtime state: this sheet's review queue and run history. */
export interface SheetState {
	history: RunView[];
	reviewQueue: Map<string, ReviewItem>;
}

/** Per-project runtime state: interpretation rule, refine conversation, caches, baselines, per-sheet state. */
export interface ProjectState {
	rule: InterpretationRule;
	refineChat: ModelMessage[];
	planCache: MemoryPlanCache;
	baseline: MemoryBaselineStore;
	sheets: Map<string, SheetState>;
}

export function newProjectState(): ProjectState {
	return {
		rule: establishRuleFromHeaders([]),
		refineChat: [],
		planCache: new MemoryPlanCache(),
		baseline: new MemoryBaselineStore(),
		sheets: new Map(),
	};
}

/** Get (creating if absent) the runtime state for one sheet within a project. */
export function sheetState(st: ProjectState, sheetId: string): SheetState {
	let s = st.sheets.get(sheetId);
	if (!s) {
		s = { history: [], reviewQueue: new Map() };
		st.sheets.set(sheetId, s);
	}
	return s;
}

/** Resolve which sheet id a request should target: the given id if it's one of the project's sheets, else the first sheet, else a fallback. */
export function resolveSheetId(project: { sheets: { id: string }[] } | undefined, sheetId?: string): string {
	if (!project) return "__default__";
	if (sheetId && project.sheets.some((s) => s.id === sheetId)) return sheetId;
	return project.sheets[0]?.id ?? "__default__";
}

const STATE_VERSION = 2 as const;

interface PersistedState {
	version: typeof STATE_VERSION;
	rule: InterpretationRule;
	refineChat: ModelMessage[];
	planCache: PlanCacheEntry[];
	baselines: Baseline[];
	sheets: { sheetId: string; history: RunView[]; reviewQueue: ReviewItem[] }[];
}

/** v1 (pre-multi-sheet) persisted shape, kept only to migrate old disk state on load. */
interface PersistedStateV1 {
	version?: number;
	rule: InterpretationRule;
	refineChat: ModelMessage[];
	planCache: PlanCacheEntry[];
	baselines: Baseline[];
	reviewQueue: ReviewItem[];
	history: RunView[];
}

/**
 * Migrate a raw persisted snapshot to the current (v2, per-sheet) shape.
 * v2 input is returned as-is (idempotent). v1/missing input has its single
 * flat history/reviewQueue folded into one sheet keyed by `defaultSheetId`.
 */
export function migrateState(raw: unknown, defaultSheetId: string): PersistedState {
	const o = (raw ?? {}) as Partial<PersistedState> & Partial<PersistedStateV1>;
	if (o.version === 2 && Array.isArray((o as Partial<PersistedState>).sheets)) return o as PersistedState;
	const v1 = o as Partial<PersistedStateV1>;
	const history = (Array.isArray(v1.history) ? v1.history : []).map((r) =>
		r.sheetId ? r : { ...r, sheetId: defaultSheetId },
	);
	const reviewQueue = (Array.isArray(v1.reviewQueue) ? v1.reviewQueue : []).map((it) =>
		it.sheetId ? it : { ...it, sheetId: defaultSheetId },
	);
	return {
		version: 2,
		rule: v1.rule as InterpretationRule,
		refineChat: v1.refineChat ?? [],
		planCache: v1.planCache ?? [],
		baselines: v1.baselines ?? [],
		sheets: [{ sheetId: defaultSheetId, history, reviewQueue }],
	};
}

/** Where per-project state files live. Overridable via env for hermetic tests. */
export function stateBaseDir(): string {
	return process.env.TEST_OSTERONE_STATE_DIR?.trim() || join(homedir(), ".test-osterone", "studio-state");
}

function stateFilePath(baseDir: string, projectId: string): string {
	const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, "_") || "_";
	return join(baseDir, `${safe}.json`);
}

/** Flatten a live ProjectState into a JSON-serializable snapshot. */
export function serializeProjectState(st: ProjectState): PersistedState {
	return {
		version: STATE_VERSION,
		rule: st.rule,
		refineChat: st.refineChat,
		planCache: st.planCache.entries(),
		baselines: st.baseline.entries(),
		sheets: [...st.sheets.entries()].map(([sheetId, s]) => ({
			sheetId,
			history: s.history,
			reviewQueue: [...s.reviewQueue.values()],
		})),
	};
}

/** Restore a persisted snapshot into an existing (usually fresh) ProjectState in place. */
export function restoreProjectState(st: ProjectState, raw: unknown, defaultSheetId: string): void {
	const v = migrateState(raw, defaultSheetId);
	if (v.rule && typeof v.rule === "object") {
		try {
			st.rule = parseRule(JSON.stringify(v.rule));
		} catch {
			// keep the default rule if the persisted one is malformed
		}
	}
	if (Array.isArray(v.refineChat)) st.refineChat = v.refineChat;
	if (Array.isArray(v.planCache)) st.planCache.load(v.planCache);
	if (Array.isArray(v.baselines)) st.baseline.load(v.baselines);
	st.sheets = new Map();
	if (Array.isArray(v.sheets)) {
		for (const s of v.sheets) {
			st.sheets.set(s.sheetId, {
				history: Array.isArray(s.history) ? s.history : [],
				reviewQueue: new Map((Array.isArray(s.reviewQueue) ? s.reviewQueue : []).map((it) => [it.caseId, it])),
			});
		}
	}
}

/** Write a project's runtime state to disk (best-effort; callers may swallow errors). */
export function persistProjectState(projectId: string, st: ProjectState, baseDir = stateBaseDir()): void {
	mkdirSync(baseDir, { recursive: true });
	writeFileSync(stateFilePath(baseDir, projectId), JSON.stringify(serializeProjectState(st)));
}

/** Load a project's runtime state from disk into `st`. Returns true if a file was found. */
export function loadProjectState(
	projectId: string,
	st: ProjectState,
	baseDir = stateBaseDir(),
	defaultSheetId = "__default__",
): boolean {
	try {
		restoreProjectState(st, JSON.parse(readFileSync(stateFilePath(baseDir, projectId), "utf8")), defaultSheetId);
		return true;
	} catch {
		return false;
	}
}

/** Remove a project's persisted state file (e.g. when the project is deleted). */
export function deleteProjectState(projectId: string, baseDir = stateBaseDir()): void {
	rmSync(stateFilePath(baseDir, projectId), { force: true });
}
