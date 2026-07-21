import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	deleteProjectState,
	layeredBaseline,
	loadProjectState,
	migrateState,
	newProjectState,
	persistProjectState,
	type ReviewItem,
	type RunView,
	resolveSheetId,
	restoreProjectState,
	serializeProjectState,
	sheetState,
	stateBaseDir,
} from "../src/app/studio/store.ts";

const dir = mkdtempSync(join(tmpdir(), "osterone-state-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const DEFAULT_SHEET = "__default__";

/** Populate one sheet with one of each persisted artifact. */
function seed() {
	const st = newProjectState();
	const s = sheetState(st, DEFAULT_SHEET);
	s.rule = { ...s.rule, ruleVersion: 7, mapping: { title: "Title", step: "Steps" } };
	s.baseline.propose("c1", 7, "prod", "Welcome ⟦MASK⟧ back");
	s.baseline.approve("c1", 7, "prod");
	s.baseline.propose("c2", 7, "prod", "pending text");
	s.planCache.set("k1", {
		actions: [{ kind: "goto", path: "/login" }],
		assertions: [{ kind: "textIncludes", value: "hello" }],
	});
	const review: ReviewItem = {
		caseId: "c2",
		title: "Case 2",
		verdict: "needs_review",
		reason: "baseline pending approval",
		url: "/x",
		text: "snapshot",
		ruleVersion: 7,
		env: "prod",
		sheetId: DEFAULT_SHEET,
	};
	s.reviewQueue.set(review.caseId, review);
	const run: RunView = {
		at: 123,
		source: "project",
		baseUrl: "https://app.test",
		interpreter: "rule",
		counts: { pass: 1, fail: 0, needs_review: 1, error: 0 },
		results: [],
		sheetId: DEFAULT_SHEET,
	};
	s.history.unshift(run);
	return st;
}

test("serialize -> restore round-trips per-sheet rule, baselines, plan cache, review queue, history", () => {
	const restored = newProjectState();
	restoreProjectState(restored, serializeProjectState(seed()), DEFAULT_SHEET);
	const s = sheetState(restored, DEFAULT_SHEET);
	expect(s.rule.ruleVersion).toBe(7);
	expect(s.rule.mapping.title).toBe("Title");
	expect(s.baseline.entries()).toHaveLength(2);
	expect(s.planCache.get("k1")?.actions[0]).toEqual({ kind: "goto", path: "/login" });
	expect(s.reviewQueue.get("c2")?.title).toBe("Case 2");
	expect(s.history).toHaveLength(1);
	expect(s.history[0]?.counts.needs_review).toBe(1);
});

test("an approved baseline still gates to match after a disk round-trip (approvals survive restart)", () => {
	persistProjectState("p_alpha", seed(), dir);
	const restored = newProjectState();
	expect(loadProjectState("p_alpha", restored, dir, DEFAULT_SHEET)).toBe(true);
	const s = sheetState(restored, DEFAULT_SHEET);
	expect(s.baseline.gate("c1", 7, "prod", "Welcome ⟦MASK⟧ back")).toEqual({ status: "match" });
	expect(s.baseline.gate("c2", 7, "prod", "pending text").status).toBe("unapproved");
});

test("loadProjectState returns false when no state file exists", () => {
	const st = newProjectState();
	expect(loadProjectState("does-not-exist", st, dir)).toBe(false);
	expect(sheetState(st, DEFAULT_SHEET).baseline.entries()).toHaveLength(0);
});

test("deleteProjectState removes the persisted file", () => {
	persistProjectState("p_del", seed(), dir);
	expect(loadProjectState("p_del", newProjectState(), dir)).toBe(true);
	deleteProjectState("p_del", dir);
	expect(loadProjectState("p_del", newProjectState(), dir)).toBe(false);
});

test("a malformed persisted rule falls back to the default without dropping sibling state", () => {
	const st = newProjectState();
	restoreProjectState(
		st,
		{
			rule: { nope: true },
			baselines: [{ caseId: "c1", ruleVersion: 1, env: "e", maskedText: "x", approved: true, createdAt: 0 }],
		},
		DEFAULT_SHEET,
	);
	expect(st.defaultRule.ruleId).toBe("default");
	expect(st.legacyBaseline.entries()).toHaveLength(1);
});

test("stateBaseDir honors the TEST_OSTERONE_STATE_DIR override", () => {
	const prev = process.env.TEST_OSTERONE_STATE_DIR;
	process.env.TEST_OSTERONE_STATE_DIR = dir;
	try {
		expect(stateBaseDir()).toBe(dir);
	} finally {
		if (prev === undefined) delete process.env.TEST_OSTERONE_STATE_DIR;
		else process.env.TEST_OSTERONE_STATE_DIR = prev;
	}
});

test("migrateState (v2 -> v3) moves project rule to defaultRule, baselines to legacy, clones per-sheet rule", () => {
	const sheetId = "sh_1700000000000_abcde";
	const v2 = {
		version: 2,
		rule: { ruleId: "default", ruleVersion: 3, mapping: { title: "T" }, intents: {} },
		refineChat: [{ role: "user", content: "hi" }],
		planCache: [{ key: "k1", plan: { actions: [], assertions: [] } }],
		baselines: [{ caseId: "c1", ruleVersion: 3, env: "prod", maskedText: "x", approved: true, createdAt: 1 }],
		sheets: [{ sheetId, history: [], reviewQueue: [] }],
	};
	const result = migrateState(v2, sheetId);
	expect(result.version).toBe(3);
	expect(result.defaultRule.ruleVersion).toBe(3);
	expect(result.legacyBaselines).toEqual(v2.baselines);
	expect(result.sheets).toHaveLength(1);
	expect(result.sheets[0]?.rule.ruleVersion).toBe(3);
	expect(result.sheets[0]?.baselines).toHaveLength(0);
	expect(result.sheets[0]?.refineChat).toHaveLength(1);
	expect(result.sheets[0]?.planCache).toHaveLength(1);
});

test("migrateState folds a v1 snapshot's flat history/reviewQueue into one sheet", () => {
	const sheetId = "sh_1700000000000_abcde";
	const v1 = {
		version: 1,
		rule: { ruleId: "default", ruleVersion: 3, mapping: {}, intents: {} },
		refineChat: [],
		planCache: [],
		baselines: [{ caseId: "c1", ruleVersion: 3, env: "prod", maskedText: "x", approved: true, createdAt: 1 }],
		reviewQueue: [
			{
				caseId: "c9",
				title: "C9",
				verdict: "needs_review",
				reason: "pending",
				url: "",
				text: "",
				ruleVersion: 3,
				env: "prod",
			},
		],
		history: [
			{
				at: 1,
				source: "project",
				baseUrl: "https://app.test",
				interpreter: "rule",
				counts: { pass: 0, fail: 0, needs_review: 1, error: 0 },
				results: [],
			},
		],
	};
	const result = migrateState(v1, sheetId);
	expect(result.version).toBe(3);
	expect(result.sheets).toHaveLength(1);
	expect(result.sheets[0]?.sheetId).toBe(sheetId);
	expect(result.sheets[0]?.history[0]?.sheetId).toBe(sheetId);
	expect(result.sheets[0]?.reviewQueue[0]?.sheetId).toBe(sheetId);
	expect(result.legacyBaselines).toEqual(v1.baselines);
});

test("migrateState is idempotent on an already-v3 snapshot", () => {
	const sheetId = "sh_1700000000000_abcde";
	const v1 = {
		version: 1,
		rule: { ruleId: "default", ruleVersion: 1, mapping: {}, intents: {} },
		refineChat: [],
		planCache: [],
		baselines: [],
		reviewQueue: [],
		history: [],
	};
	const migrated = migrateState(v1, sheetId);
	const again = migrateState(migrated, "other-sheet-id");
	expect(again).toEqual(migrated);
});

test("resolveSheetId falls back sanely for zero/undefined/mismatched sheets", () => {
	expect(resolveSheetId({ sheets: [] })).toBe("__default__");
	expect(resolveSheetId(undefined)).toBe("__default__");
	expect(resolveSheetId({ sheets: [{ id: "a" }] }, "x")).toBe("a");
	expect(resolveSheetId({ sheets: [{ id: "a" }, { id: "b" }] }, "b")).toBe("b");
});

test("persist/load round-trip keeps two sheets isolated (rule + history)", () => {
	const st = newProjectState();
	const a = sheetState(st, "A");
	a.rule = { ...a.rule, ruleVersion: 10 };
	a.history.push({
		at: 1,
		source: "project",
		baseUrl: "https://a.test",
		interpreter: "rule",
		counts: { pass: 1, fail: 0, needs_review: 0, error: 0 },
		results: [],
		sheetId: "A",
	});
	const b = sheetState(st, "B");
	b.rule = { ...b.rule, ruleVersion: 20 };
	b.history.push({
		at: 2,
		source: "project",
		baseUrl: "https://b.test",
		interpreter: "rule",
		counts: { pass: 0, fail: 1, needs_review: 0, error: 0 },
		results: [],
		sheetId: "B",
	});
	persistProjectState("p_multi", st, dir);
	const fresh = newProjectState();
	expect(loadProjectState("p_multi", fresh, dir, "A")).toBe(true);
	expect(sheetState(fresh, "A").rule.ruleVersion).toBe(10);
	expect(sheetState(fresh, "B").rule.ruleVersion).toBe(20);
	expect(sheetState(fresh, "A").history[0]?.baseUrl).toBe("https://a.test");
	expect(sheetState(fresh, "B").history[0]?.baseUrl).toBe("https://b.test");
});

test("legacy approved baseline still matches for a sheet with no own baseline; mismatched content does not (false-pass=0)", () => {
	const st = newProjectState();
	st.legacyBaseline.propose("c1", 5, "prod", "Golden ⟦MASK⟧ screen");
	st.legacyBaseline.approve("c1", 5, "prod");
	const layered = layeredBaseline(st, "sheetX");
	expect(layered.gate("c1", 5, "prod", "Golden ⟦MASK⟧ screen")).toEqual({ status: "match" });
	expect(layered.gate("c1", 5, "prod", "DIFFERENT screen").status).toBe("drift");
	expect(layered.gate("c9", 5, "prod", "unseen").status).toBe("no_baseline");
	expect(sheetState(st, "sheetX").baseline.get("c9", 5, "prod")).toBeDefined();
	expect(st.legacyBaseline.get("c9", 5, "prod")).toBeUndefined();
});
