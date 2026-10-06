import { expect, test } from "bun:test";
import { join } from "node:path";
import { isCanonicalQc, parseArgs, planStages, stageStops, UsageError } from "../src/app/harness.ts";

test("a QC already written in the canonical grammar runs as is; a free-language one needs a 작업시트", async () => {
	expect(await isCanonicalQc("e2e/fixtures/qc-cases.xlsx")).toBe(true);
	expect(await isCanonicalQc("e2e/fixtures/qc-cases-nl.xlsx")).toBe(false);
	const stages = planStages(parseArgs(["--spec", "s.md", "--qc", "qc.xlsx", "--fixture", "--out", "o"]), true);
	expect(stages.map((s) => s.name)).toEqual(["check", "run"]);
	expect(stages[0]?.args).toEqual(["qc.xlsx"]);
});

test("an existing QC is turned into a 작업시트 before it runs", () => {
	const stages = planStages(
		parseArgs(["--", "--spec", "spec.md", "--repo", "src", "--qc", "qc.xlsx", "--fixture", "--out", "out"]),
	);
	expect(stages.map((s) => s.name)).toEqual(["worksheet", "check", "run"]);
	expect(stages[0]?.args).toEqual([
		"qc.xlsx",
		"--spec",
		"spec.md",
		"--repo",
		"src",
		"--out",
		join("out", "worksheet.xlsx"),
	]);
	expect(stages[2]?.args.slice(0, 4)).toEqual([join("out", "worksheet.xlsx"), "--fixture", "--backend", "playwright"]);
});

test("without a QC the 기획서 generates one, and the generated sheet is what runs", () => {
	const stages = planStages(
		parseArgs(["--spec", "spec.md", "--url", "http://app.test", "--backend", "bsk", "--out", "o"]),
	);
	expect(stages.map((s) => s.name)).toEqual(["generate", "check", "run"]);
	expect(stages[0]?.args).toEqual(["--spec", "spec.md", "--out", join("o", "generated-qc.xlsx")]);
	expect(stages[2]?.args).toContain("http://app.test");
	expect(stages[2]?.args).toContain("bsk");
});

test("--export-e2e adds the e2e suite as the last stage, pointed at the same app", () => {
	const stages = planStages(parseArgs(["--spec", "s.md", "--url", "http://app.test", "--export-e2e", "--out", "o"]));
	expect(stages.at(-1)).toEqual({
		name: "export",
		script: "src/app/export-e2e.ts",
		args: [join("o", "generated-qc.xlsx"), "--out", join("o", "e2e-suite"), "--url", "http://app.test"],
	});
});

test("a run's fail and held verdicts are results, not a broken pipeline; any other stage error stops it", () => {
	const [authoring, , run] = planStages(parseArgs(["--spec", "s.md", "--fixture"]));
	if (!authoring || !run) throw new Error("expected authoring and run stages");
	expect([0, 1, 3].map((code) => stageStops(run, code))).toEqual([false, false, false]);
	expect(stageStops(run, 2)).toBe(true);
	expect(stageStops(authoring, 1)).toBe(true);
	expect(stageStops(authoring, 0)).toBe(false);
});

test("the harness refuses to guess a target, a backend or a missing spec", () => {
	expect(() => parseArgs(["--spec", "s.md"])).toThrow(UsageError);
	expect(() => parseArgs(["--spec", "s.md", "--fixture", "--url", "http://x"])).toThrow(/exactly one target/);
	expect(() => parseArgs(["--fixture"])).toThrow(/--spec/);
	expect(() => parseArgs(["--spec", "s.md", "--fixture", "--backend", "selenium"])).toThrow(/playwright or bsk/);
	expect(() => parseArgs(["--spec", "s.md", "--fixture", "--qcc", "x"])).toThrow(/unknown flag: --qcc/);
});
