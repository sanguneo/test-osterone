import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	deleteProjectState,
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

/** Populate a project state with one of each persisted artifact, on one sheet. */
function seed() {
	const st = newProjectState();
	st.rule = { ...st.rule, ruleVersion: 7, mapping: { title: "Title", step: "Steps" } };
	st.baseline.propose("c1", 7, "prod", "Welcome ⟦MASK⟧ back");
	st.baseline.approve("c1", 7, "prod");
	st.baseline.propose("c2", 7, "prod", "pending text");
	st.planCache.set("k1", {
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
	sheetState(st, DEFAULT_SHEET).reviewQueue.set(review.caseId, review);
	const run: RunView = {
		at: 123,
		source: "project",
		baseUrl: "https://app.test",
		interpreter: "rule",
		counts: { pass: 1, fail: 0, needs_review: 1, error: 0 },
		results: [],
		sheetId: DEFAULT_SHEET,
	};
	sheetState(st, DEFAULT_SHEET).history.unshift(run);
	return st;
}

test("serialize -> restore round-trips rule, baselines, plan cache, review queue, history", () => {
	const restored = newProjectState();
	restoreProjectState(restored, serializeProjectState(seed()), DEFAULT_SHEET);

	expect(restored.rule.ruleVersion).toBe(7);
	expect(restored.rule.mapping.title).toBe("Title");
	expect(restored.baseline.entries()).toHaveLength(2);
	expect(restored.planCache.get("k1")?.actions[0]).toEqual({ kind: "goto", path: "/login" });
	const sheet = sheetState(restored, DEFAULT_SHEET);
	expect(sheet.reviewQueue.get("c2")?.title).toBe("Case 2");
	expect(sheet.history).toHaveLength(1);
	expect(sheet.history[0]?.counts.needs_review).toBe(1);
});

test("an approved baseline still gates to match after a disk round-trip (approvals survive restart)", () => {
	persistProjectState("p_alpha", seed(), dir);

	const restored = newProjectState();
	expect(loadProjectState("p_alpha", restored, dir, DEFAULT_SHEET)).toBe(true);

	// Approved + masked text matches -> pass gate (the whole point of persisting reviews).
	expect(restored.baseline.gate("c1", 7, "prod", "Welcome ⟦MASK⟧ back")).toEqual({ status: "match" });
	// The still-pending baseline must NOT silently pass after restore.
	expect(restored.baseline.gate("c2", 7, "prod", "pending text").status).toBe("unapproved");
});

test("loadProjectState returns false when no state file exists", () => {
	const st = newProjectState();
	expect(loadProjectState("does-not-exist", st, dir)).toBe(false);
	expect(st.baseline.entries()).toHaveLength(0);
});

test("deleteProjectState removes the persisted file", () => {
	persistProjectState("p_del", seed(), dir);
	expect(loadProjectState("p_del", newProjectState(), dir)).toBe(true);
	deleteProjectState("p_del", dir);
	expect(loadProjectState("p_del", newProjectState(), dir)).toBe(false);
});

test("a malformed persisted rule falls back to the default without dropping other state", () => {
	const st = newProjectState();
	restoreProjectState(
		st,
		{
			rule: { nope: true },
			baselines: [{ caseId: "c1", ruleVersion: 1, env: "e", maskedText: "x", approved: true, createdAt: 0 }],
		},
		DEFAULT_SHEET,
	);
	expect(st.rule.ruleId).toBe("default"); // default kept
	expect(st.baseline.entries()).toHaveLength(1); // sibling state still restored
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

test("migrateState folds a v1 snapshot's flat history/reviewQueue into one sheet", () => {
	const sheetId = "sh_1700000000000_abcde";
	const v1 = {
		version: 1,
		rule: { ruleId: "default", ruleVersion: 3, mapping: {}, intents: {} },
		refineChat: [],
		planCache: [{ key: "k1", plan: { actions: [], assertions: [] } }],
		baselines: [{ caseId: "c1", ruleVersion: 3, env: "prod", maskedText: "x", approved: true, createdAt: 1 }],
		reviewQueue: [
			{
				caseId: "c9",
				title: "C9",
				verdict: "needs_review",
				reason: "baseline pending approval",
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

	expect(result.version).toBe(2);
	expect(result.sheets).toHaveLength(1);
	expect(result.sheets[0]?.sheetId).toBe(sheetId);
	expect(result.sheets[0]?.history).toHaveLength(1);
	expect(result.sheets[0]?.history[0]?.sheetId).toBe(sheetId);
	expect(result.sheets[0]?.reviewQueue).toHaveLength(1);
	expect(result.sheets[0]?.reviewQueue[0]?.sheetId).toBe(sheetId);
	expect(result.baselines).toEqual(v1.baselines);
	expect(result.planCache).toEqual(v1.planCache);
});

test("migrateState is idempotent on an already-v2 snapshot", () => {
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
	expect(
		resolveSheetId(
			{
				sheets: [{ id: "a" }, { id: "b" }],
			},
			"b",
		),
	).toBe("b");
});

test("persist/load round-trip keeps two sheets isolated", () => {
	const st = newProjectState();
	sheetState(st, "A").history.push({
		at: 1,
		source: "project",
		baseUrl: "https://a.test",
		interpreter: "rule",
		counts: { pass: 1, fail: 0, needs_review: 0, error: 0 },
		results: [],
		sheetId: "A",
	});
	sheetState(st, "B").history.push({
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
	expect(sheetState(fresh, "A").history).toHaveLength(1);
	expect(sheetState(fresh, "A").history[0]?.baseUrl).toBe("https://a.test");
	expect(sheetState(fresh, "B").history).toHaveLength(1);
	expect(sheetState(fresh, "B").history[0]?.baseUrl).toBe("https://b.test");
});
