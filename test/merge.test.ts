import { expect, test } from "bun:test";
import { csvToRawTable, ingestCsv } from "../src/intake/ingest.ts";
import { mergeSheetCsv } from "../src/intake/merge.ts";

test("tab merge aligns reordered columns and retains fields absent from the first tab", () => {
	const csv = mergeSheetCsv([
		{ name: "First", csv: "ID,Title,Steps,Expected\n1,Login,Click Login,Welcome" },
		{ name: "Second", csv: "Expected,Steps,Title,ID,Role\nDenied,Click Delete,Permission,2,viewer" },
	]);
	const cases = ingestCsv(csv).unique;
	expect(cases).toHaveLength(2);
	expect(cases[1]).toMatchObject({
		sourceId: "2",
		title: "Permission",
		steps: ["Click Delete"],
		expected: "Denied",
		role: "viewer",
		category: "Second",
	});
});

test("tab merge aligns equivalent Korean and English headers without discarding extra columns", () => {
	const csv = mergeSheetCsv([
		{ name: "First", csv: "ID,Title,Steps,Expected\n1,Login,Click Login,Welcome" },
		{
			name: "Second",
			csv: "번호,소분류,시험절차,예상결과,사전조건,검증 결과,비고,기획서\n2,권한,삭제 클릭,거부,뷰어 로그인,Fail,권한 누락,spec-42",
		},
	]);
	expect(ingestCsv(csv).unique[1]).toMatchObject({
		sourceId: "2",
		title: "권한",
		steps: ["삭제 클릭"],
		expected: "거부",
		precondition: "뷰어 로그인",
		recordedVerdict: "Fail",
		note: "권한 누락",
	});
	expect(csvToRawTable(csv).rows[1]?.기획서).toBe("spec-42");
});

test("tab merge preserves both the tab name and an existing category", () => {
	const csv = mergeSheetCsv([{ name: "Admin", csv: "분류,Title,Steps,Expected\nUsers,권한,Click Delete,Denied" }]);
	expect(ingestCsv(csv).unique[0]?.category).toBe("Admin / Users");
});

test("tab merge retains multiline quotes and commas in their original cells", () => {
	const csv = mergeSheetCsv([
		{ name: 'Tab, "A"', csv: 'Title,Steps,Expected\nLogin,"First\nSecond","Welcome, ""user""\nDone"' },
	]);
	expect(ingestCsv(csv).unique[0]).toMatchObject({
		category: 'Tab, "A"',
		steps: ["First", "Second"],
		expected: 'Welcome, "user"\nDone',
	});
});

test("tab merge retains every procedure and expectation under duplicate headers", () => {
	const csv = mergeSheetCsv([
		{
			name: "Cases",
			csv: "ID,Title,Steps,Steps,Expected,Expected\n1,Login,Open login,Click Sign in,Welcome,Dashboard",
		},
	]);
	expect(ingestCsv(csv).unique[0]).toMatchObject({
		steps: ["Open login", "Click Sign in"],
		expected: "Welcome\nDashboard",
	});
});

test("tab merge preserves separators so an anonymous case cannot join a previous case", () => {
	const csv = mergeSheetCsv([
		{ name: "Cases", csv: "ID,Title,Steps,Expected\n1,Login,Open login,Welcome\n,,,\n,,Click Delete,Denied" },
	]);
	const cases = ingestCsv(csv).unique;
	expect(cases).toHaveLength(2);
	expect(cases[1]?.sourceId).toBeNull();
	expect(cases[0]?.steps).toEqual(["Open login"]);
});
