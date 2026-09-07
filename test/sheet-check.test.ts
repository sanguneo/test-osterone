import { expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

async function check(path: string) {
	const child = Bun.spawn(["node", "--experimental-transform-types", "src/app/check-sheet.ts", path], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, code };
}

test("sheet preflight reads the shipped cases without launching a browser or model", async () => {
	const result = await check("src/testing/sample-cases.csv");
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout)).toMatchObject({
		cases: 4,
		unique: 4,
		duplicates: 0,
		incomplete: [],
	});
});

test("sheet preflight reports incomplete cases and refuses a clean exit", async () => {
	const result = await check("test/fixtures/incomplete-cases.csv");
	expect(result.code).toBe(1);
	const report = JSON.parse(result.stdout);
	expect(report.incomplete).toEqual([
		{ sourceId: "TC-2", missing: ["expected"] },
		{ sourceId: "TC-3", missing: ["steps"] },
	]);
});

test("sheet preflight returns an explicit input error for a missing file", async () => {
	const result = await check("test/fixtures/nonexistent-sheet.xlsx");
	expect(result.code).toBe(2);
	const errorLine = result.stderr.split("\n").find((line) => line.startsWith("{"));
	expect(errorLine).toBeDefined();
	expect(JSON.parse(errorLine ?? "{}").error).toContain("ENOENT");
});
