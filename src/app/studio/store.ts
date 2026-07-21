/**
 * Durable per-project Studio state. The parent axis is the Test Sheet: each sheet owns its
 * interpretation rule, refine chat, plan cache, approved baselines, needs_review queue, and
 * run history. The Project keeps only a `defaultRule` (the seed a new sheet clones) plus a
 * read-only `legacyBaseline` fallback that carries pre-v3 project-level approvals forward.
 *
 * Everything here survives a server restart by serializing to JSON on disk — the projects
 * themselves persist to studio-projects.json; their runtime state used to live only in memory.
 *
 * Node-safe on purpose: the engine's SqliteEvidenceStore uses bun:sqlite, which is unavailable
 * under Node (Studio runs on Node because Playwright hangs under Bun on Windows), so persistence
 * here is plain JSON — no native driver, no dual-runtime split.
 *
 * Trust model (INVIOLABLE): a case only auto-passes when an APPROVED baseline exists for
 * (caseId + ruleVersion + env) AND the masked page text matches exactly (see baseline.gate).
 * Because content equality guards every match, reading legacy (project-level) baselines as a
 * fallback for any sheet cannot create a false pass — it only lets prior approvals keep matching.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Verdict } from "../../execute/runner.ts";
import { MemoryPlanCache, type PlanCacheEntry } from "../../interpret/author.ts";
import { establishRuleFromHeaders, type InterpretationRule, parseRule } from "../../interpret/rule.ts";
import {
	type Baseline,
	type BaselineGate,
	type BaselineStore,
	DEFAULT_MASKS,
	MemoryBaselineStore,
	maskDynamic,
} from "../../judge/baseline.ts";
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

export interface SheetState {
	rule: InterpretationRule;
	refineChat: ModelMessage[];
	planCache: MemoryPlanCache;
	baseline: MemoryBaselineStore;
	history: RunView[];
	reviewQueue: Map<string, ReviewItem>;
}

export interface ProjectState {
	defaultRule: InterpretationRule;
	legacyBaseline: MemoryBaselineStore;
	sheets: Map<string, SheetState>;
}

function cloneRule(rule: InterpretationRule): InterpretationRule {
	return structuredClone(rule);
}

function safeParseRule(raw: unknown): InterpretationRule | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	try {
		return parseRule(JSON.stringify(raw));
	} catch {
		return undefined;
	}
}

export function newSheetState(seedRule: InterpretationRule): SheetState {
	return {
		rule: cloneRule(seedRule),
		refineChat: [],
		planCache: new MemoryPlanCache(),
		baseline: new MemoryBaselineStore(),
		history: [],
		reviewQueue: new Map(),
	};
}

export function newProjectState(): ProjectState {
	return {
		defaultRule: establishRuleFromHeaders([]),
		legacyBaseline: new MemoryBaselineStore(),
		sheets: new Map(),
	};
}

export function sheetState(st: ProjectState, sheetId: string): SheetState {
	let s = st.sheets.get(sheetId);
	if (!s) {
		s = newSheetState(st.defaultRule);
		st.sheets.set(sheetId, s);
	}
	return s;
}

export class LayeredBaselineStore implements BaselineStore {
	constructor(
		private readonly sheet: MemoryBaselineStore,
		private readonly legacy: MemoryBaselineStore,
	) {}

	get(caseId: string, ruleVersion: number, env: string): Baseline | undefined {
		return this.sheet.get(caseId, ruleVersion, env) ?? this.legacy.get(caseId, ruleVersion, env);
	}

	propose(
		caseId: string,
		ruleVersion: number,
		env: string,
		snapshotText: string,
		masks: RegExp[] = DEFAULT_MASKS,
	): Baseline {
		return this.sheet.propose(caseId, ruleVersion, env, snapshotText, masks);
	}

	approve(caseId: string, ruleVersion: number, env: string): void {
		this.sheet.approve(caseId, ruleVersion, env);
	}

	gate(
		caseId: string,
		ruleVersion: number,
		env: string,
		currentText: string,
		masks: RegExp[] = DEFAULT_MASKS,
	): BaselineGate {
		if (this.sheet.get(caseId, ruleVersion, env)) return this.sheet.gate(caseId, ruleVersion, env, currentText, masks);
		const legacy = this.legacy.get(caseId, ruleVersion, env);
		if (legacy) {
			if (!legacy.approved) return { status: "unapproved", reason: "baseline exists but is not approved" };
			const currentMasked = maskDynamic(currentText, masks);
			if (currentMasked === legacy.maskedText) return { status: "match" };
			return { status: "drift", baselineMasked: legacy.maskedText, currentMasked };
		}
		return this.sheet.gate(caseId, ruleVersion, env, currentText, masks);
	}
}

export function layeredBaseline(st: ProjectState, sheetId: string): LayeredBaselineStore {
	return new LayeredBaselineStore(sheetState(st, sheetId).baseline, st.legacyBaseline);
}

export function resolveSheetId(project: { sheets: { id: string }[] } | undefined, sheetId?: string): string {
	if (!project) return "__default__";
	if (sheetId && project.sheets.some((s) => s.id === sheetId)) return sheetId;
	return project.sheets[0]?.id ?? "__default__";
}

const STATE_VERSION = 3 as const;

interface PersistedSheet {
	sheetId: string;
	rule: InterpretationRule;
	refineChat: ModelMessage[];
	planCache: PlanCacheEntry[];
	baselines: Baseline[];
	history: RunView[];
	reviewQueue: ReviewItem[];
}

interface PersistedState {
	version: typeof STATE_VERSION;
	defaultRule: InterpretationRule;
	legacyBaselines: Baseline[];
	sheets: PersistedSheet[];
}

interface PersistedStateV2 {
	version?: number;
	rule: InterpretationRule;
	refineChat: ModelMessage[];
	planCache: PlanCacheEntry[];
	baselines: Baseline[];
	sheets: { sheetId: string; history: RunView[]; reviewQueue: ReviewItem[] }[];
}
interface PersistedStateV1 {
	version?: number;
	rule: InterpretationRule;
	refineChat: ModelMessage[];
	planCache: PlanCacheEntry[];
	baselines: Baseline[];
	reviewQueue: ReviewItem[];
	history: RunView[];
}

export function migrateState(raw: unknown, defaultSheetId: string): PersistedState {
	const o = (raw ?? {}) as Partial<PersistedState> & Partial<PersistedStateV2> & Partial<PersistedStateV1>;
	const version = (o as { version?: number }).version;
	if (version === 3 && Array.isArray((o as Partial<PersistedState>).sheets)) return o as PersistedState;

	const rule = (o.rule as InterpretationRule) ?? establishRuleFromHeaders([]);
	const refineChat = Array.isArray(o.refineChat) ? o.refineChat : [];
	const planCache = Array.isArray(o.planCache) ? o.planCache : [];
	const baselines = Array.isArray(o.baselines) ? o.baselines : [];

	let entries: { sheetId: string; history: RunView[]; reviewQueue: ReviewItem[] }[];
	if (version === 2 && Array.isArray((o as PersistedStateV2).sheets)) {
		entries = (o as PersistedStateV2).sheets.map((s) => ({
			sheetId: s.sheetId,
			history: Array.isArray(s.history) ? s.history : [],
			reviewQueue: Array.isArray(s.reviewQueue) ? s.reviewQueue : [],
		}));
	} else {
		const v1 = o as Partial<PersistedStateV1>;
		const history = (Array.isArray(v1.history) ? v1.history : []).map((r) =>
			r.sheetId ? r : { ...r, sheetId: defaultSheetId },
		);
		const reviewQueue = (Array.isArray(v1.reviewQueue) ? v1.reviewQueue : []).map((it) =>
			it.sheetId ? it : { ...it, sheetId: defaultSheetId },
		);
		entries = [{ sheetId: defaultSheetId, history, reviewQueue }];
	}
	if (entries.length === 0) entries = [{ sheetId: defaultSheetId, history: [], reviewQueue: [] }];
	const foldId = entries.some((s) => s.sheetId === defaultSheetId)
		? defaultSheetId
		: (entries[0]?.sheetId ?? defaultSheetId);

	return {
		version: STATE_VERSION,
		defaultRule: rule,
		legacyBaselines: baselines,
		sheets: entries.map((s) => ({
			sheetId: s.sheetId,
			rule,
			refineChat: s.sheetId === foldId ? refineChat : [],
			planCache: s.sheetId === foldId ? planCache : [],
			baselines: [],
			history: s.history.map((r) => (r.sheetId ? r : { ...r, sheetId: s.sheetId })),
			reviewQueue: s.reviewQueue.map((it) => (it.sheetId ? it : { ...it, sheetId: s.sheetId })),
		})),
	};
}

export function stateBaseDir(): string {
	return process.env.TEST_OSTERONE_STATE_DIR?.trim() || join(homedir(), ".test-osterone", "studio-state");
}

function stateFilePath(baseDir: string, projectId: string): string {
	const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, "_") || "_";
	return join(baseDir, `${safe}.json`);
}

export function serializeProjectState(st: ProjectState): PersistedState {
	return {
		version: STATE_VERSION,
		defaultRule: st.defaultRule,
		legacyBaselines: st.legacyBaseline.entries(),
		sheets: [...st.sheets.entries()].map(([sheetId, s]) => ({
			sheetId,
			rule: s.rule,
			refineChat: s.refineChat,
			planCache: s.planCache.entries(),
			baselines: s.baseline.entries(),
			history: s.history,
			reviewQueue: [...s.reviewQueue.values()],
		})),
	};
}

export function restoreProjectState(st: ProjectState, raw: unknown, defaultSheetId: string): void {
	const v = migrateState(raw, defaultSheetId);
	st.defaultRule = safeParseRule(v.defaultRule) ?? establishRuleFromHeaders([]);
	st.legacyBaseline = new MemoryBaselineStore();
	if (Array.isArray(v.legacyBaselines)) st.legacyBaseline.load(v.legacyBaselines);
	st.sheets = new Map();
	for (const s of v.sheets) {
		const ss = newSheetState(st.defaultRule);
		ss.rule = safeParseRule(s.rule) ?? cloneRule(st.defaultRule);
		ss.refineChat = Array.isArray(s.refineChat) ? s.refineChat : [];
		ss.planCache.load(Array.isArray(s.planCache) ? s.planCache : []);
		ss.baseline.load(Array.isArray(s.baselines) ? s.baselines : []);
		ss.history = Array.isArray(s.history) ? s.history : [];
		ss.reviewQueue = new Map((Array.isArray(s.reviewQueue) ? s.reviewQueue : []).map((it) => [it.caseId, it]));
		st.sheets.set(s.sheetId, ss);
	}
}

export function persistProjectState(projectId: string, st: ProjectState, baseDir = stateBaseDir()): void {
	mkdirSync(baseDir, { recursive: true });
	writeFileSync(stateFilePath(baseDir, projectId), JSON.stringify(serializeProjectState(st)));
}

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

export function deleteProjectState(projectId: string, baseDir = stateBaseDir()): void {
	rmSync(stateFilePath(baseDir, projectId), { force: true });
}
