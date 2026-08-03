/**
 * The dashboard's stale-response guard (debt M2: "stale 요청 순서").
 *
 * Switching sheets fires a second history fetch while the first is still in flight, and the network
 * decides which lands first. Without a guard the slower, older answer overwrites the newer one and the
 * panel shows one sheet's numbers under another sheet's name — the quietest possible wrong reading, and
 * the reason this panel counts its requests. Nothing observed that until this test.
 */
import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Project, RunView } from "../src/app/studio/web/src/types.ts";

const sheet = (id: string, name: string) => ({ id, name, kind: "csv" as const, sheetUrl: "", csvText: "" });
const PROJECT: Project = {
	id: "p1",
	name: "프로젝트",
	sheets: [sheet("a", "시트 A"), sheet("b", "시트 B")],
	baseUrl: "http://localhost:8790/",
	env: "test",
	accounts: [],
	referenceRepo: "",
	aiInterpret: false,
	lenientMatch: false,
};

/** One run whose pass rate is entirely determined by `passed`, so the rendered % identifies the sheet. */
function runFor(sheetId: string, passed: boolean): RunView {
	return {
		at: 1_700_000_000_000,
		source: "test",
		baseUrl: "http://localhost:8790/",
		interpreter: "rule",
		counts: { pass: passed ? 1 : 0, fail: passed ? 0 : 1, needs_review: 0, error: 0 },
		results: [
			{
				caseId: "TC-1",
				title: "케이스",
				category: null,
				steps: [],
				expected: "",
				verdict: passed ? "pass" : "fail",
				confidence: 1,
				passed: passed ? 1 : 0,
				total: 1,
				heal: [],
				assertions: [],
			},
		],
		sheetId,
	};
}

/** Hand back the promise for each sheet so the test, not the clock, decides which answer lands first. */
const pending = new Map<string, (runs: RunView[]) => void>();
mock.module("../src/app/studio/web/src/api.ts", () => ({
	api: {
		history: (_pid: string, sheetId?: string) =>
			new Promise<RunView[]>((resolve) => {
				pending.set(sheetId ?? "", resolve);
			}),
		reviewQueue: () => Promise.resolve([]),
	},
}));

const { DashboardPanel } = await import("../src/app/studio/web/src/components/DashboardPanel.tsx");

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	host?.remove();
	root = null;
	host = null;
	pending.clear();
});

const heroRate = () => host?.querySelector(".metric.hero .val")?.textContent ?? "";

test("a slow answer for the sheet you left does not overwrite the one you switched to", async () => {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	const render = (selSheetId: string) =>
		act(async () => {
			root?.render(
				<DashboardPanel selId="p1" project={PROJECT} selSheetId={selSheetId} reviewCount={0} goTo={() => {}} />,
			);
		});

	await render("a");
	expect(pending.has("a")).toBe(true);

	// Switch before the first answer arrives — this is the whole scenario.
	await render("b");
	expect(pending.has("b")).toBe(true);

	// Sheet B answers first (all failing), then the abandoned request for sheet A answers (all passing).
	await act(async () => pending.get("b")?.([runFor("b", false)]));
	expect(heroRate()).toBe("0%");
	await act(async () => pending.get("a")?.([runFor("a", true)]));

	// Still B's numbers. Without the guard the panel would now read 100% under 시트 B.
	expect(heroRate()).toBe("0%");
});
