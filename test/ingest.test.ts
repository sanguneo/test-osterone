import { expect, test } from "bun:test";
import { toCsv } from "../src/intake/csv.ts";
import {
	csvToRawTable,
	ingestCsv,
	ingestGoogleSheet,
	mapColumns,
	normalizeTable,
	parseCsv,
	toCsvExportUrl,
} from "../src/intake/ingest.ts";

test("parseCsv handles quotes, embedded commas, and embedded newlines", () => {
	const csv = 'a,b\n"x,y","line1\nline2"\n';
	expect(parseCsv(csv)).toEqual([
		["a", "b"],
		["x,y", "line1\nline2"],
	]);
});

test("parseCsv handles escaped double-quotes", () => {
	expect(parseCsv('"he said ""hi"""')).toEqual([['he said "hi"']]);
});

test("mapColumns maps common headers deterministically (exact before substring)", () => {
	const m = mapColumns(["Test ID", "Title", "Steps", "Expected Result", "Role", "Environment"]);
	expect(m).toEqual({
		id: "Test ID",
		title: "Title",
		step: "Steps",
		expected: "Expected Result",
		role: "Role",
		env: "Environment",
	});
});

const SHEET = [
	"Test ID,Title,Steps,Expected Result,Role,Environment",
	'TC-01,Viewer can sign in,"Navigate to /login\nEnter viewer\nClick Sign in",Signed in as viewer,viewer,staging',
	'TC-02,Wrong password,"Navigate to /login\nEnter wrong-pass\nClick Sign in",Invalid credentials,viewer,staging',
].join("\n");

test("normalizeTable splits steps and derives a stable content-hash caseId", () => {
	const tcs = normalizeTable(csvToRawTable(SHEET));
	expect(tcs).toHaveLength(2);
	const tc0 = tcs[0];
	if (!tc0) throw new Error("missing tc0");
	expect(tc0.title).toBe("Viewer can sign in");
	expect(tc0.steps).toEqual(["Navigate to /login", "Enter viewer", "Click Sign in"]);
	expect(tc0.expected).toBe("Signed in as viewer");
	expect(tc0.role).toBe("viewer");
	expect(tc0.sourceId).toBe("TC-01");
	expect(tc0.caseId).toBe(`TC-${tc0.contentHash}`);
	expect(tc0.contentHash).toMatch(/^[0-9a-f]{16}$/);
});

test("normalizeTable is deterministic: identical input yields identical caseIds", () => {
	const a = normalizeTable(csvToRawTable(SHEET));
	const b = normalizeTable(csvToRawTable(SHEET));
	expect(a).toEqual(b);
	expect(a.map((t) => t.caseId)).toEqual(b.map((t) => t.caseId));
});

test("dedupe removes content-duplicates deterministically (first wins, order preserved)", () => {
	// TC-03 duplicates TC-01's content (only the sheet id differs -> same normalized content).
	const withDup = `${SHEET}\nTC-03,Viewer can sign in,"Navigate to /login\nEnter viewer\nClick Sign in",Signed in as viewer,viewer,staging`;
	const { all, unique, duplicates } = ingestCsv(withDup);
	expect(all).toHaveLength(3);
	expect(unique).toHaveLength(2);
	expect(duplicates).toHaveLength(1);
	expect(duplicates[0]?.index).toBe(2);
	expect(duplicates[0]?.duplicateOfIndex).toBe(0);
});

test("dedupe treats a changed step as a distinct case (hash differs)", () => {
	const changed = `${SHEET}\nTC-04,Viewer can sign in,"Navigate to /login\nEnter viewer\nClick Log in",Signed in as viewer,viewer,staging`;
	const { unique } = ingestCsv(changed);
	expect(unique).toHaveLength(3);
});

test("csvToRawTable ignores fully blank rows", () => {
	const t = csvToRawTable("h1,h2\n,\na,b\n");
	expect(t.rows).toEqual([{ h1: "a", h2: "b" }]);
});

test("toCsvExportUrl builds the CSV export endpoint with gid", () => {
	expect(toCsvExportUrl("https://docs.google.com/spreadsheets/d/ABC123_x/edit#gid=42")).toBe(
		"https://docs.google.com/spreadsheets/d/ABC123_x/export?format=csv&gid=42",
	);
});

test("toCsvExportUrl rejects a non-sheets URL", () => {
	expect(() => toCsvExportUrl("https://example.com/x")).toThrow(/Google Sheets/);
});

test("ingestGoogleSheet fetches the CSV export and ingests it", async () => {
	const csv = "Test ID,Title,Steps,Expected Result\nA,t,Click Go,done";
	const fetchImpl = (async () => new Response(csv, { status: 200 })) as unknown as typeof fetch;
	const { all } = await ingestGoogleSheet("https://docs.google.com/spreadsheets/d/XYZ/edit", fetchImpl);
	expect(all).toHaveLength(1);
	expect(all[0]?.title).toBe("t");
});

test("mapColumns + ingest handle Korean QA headers (번호/소분류/사전조건/예상결과/중요도)", () => {
	const csv =
		'번호,대분류,소분류,중요도,사전조건,예상결과\n1,전자결재,첨부파일,상,"1. 인쇄버튼 접근\n2. 파일 내보내기",첨부되어야함\n';
	const m = mapColumns(csvToRawTable(csv).headers);
	expect(m.id).toBe("번호");
	expect(m.title).toBe("소분류");
	expect(m.step).toBe("사전조건");
	expect(m.expected).toBe("예상결과");
	expect(m.priority).toBe("중요도");
	const { unique } = ingestCsv(csv);
	expect(unique).toHaveLength(1);
	expect(unique[0]?.title).toBe("첨부파일");
	expect(unique[0]?.steps).toEqual(["1. 인쇄버튼 접근", "2. 파일 내보내기"]);
	expect(unique[0]?.expected).toBe("첨부되어야함");
	expect(unique[0]?.priority).toBe("상");
});

test("mapColumns: alias priority beats column order (사전조건 before 시험절차 must still map the procedure)", () => {
	// The real-world sheet that exposed this lists the precondition column first. Mapping steps to
	// it meant the run executed setup prose and never the actual test procedure.
	const headers = ["분류", "NO", "대분류", "중분류", "소분류", "중요도", "사전조건", "시험절차", "예상결과"];
	const m = mapColumns(headers);
	expect(m.step).toBe("시험절차");
	expect(m.title).toBe("소분류");
	expect(m.category).toBe("분류");
	// With no procedure column at all, the precondition is still better than nothing.
	expect(mapColumns(["소분류", "사전조건", "예상결과"]).step).toBe("사전조건");
});

test("ingestCsv drops spreadsheet sub-header/spacer rows that carry no case at all", () => {
	const csv = [
		"분류,소분류,시험절차,예상결과",
		"탭A,,,",
		"탭A,로그인,1. 로그인 버튼 선택,대시보드 진입",
		"탭A,,,",
	].join("\n");
	const { unique } = ingestCsv(csv);
	expect(unique).toHaveLength(1);
	expect(unique[0]?.title).toBe("로그인");
});

test("csv round-trip keeps a multi-line cell intact when a category column is prepended", () => {
	// This is exactly what the xlsx tab-merge does. Doing it line-by-line (the old way) injected the
	// category into the middle of the quoted cell; doing it per record must not.
	const tab = 'NO,예상결과\n1,"1. 첫째 줄\n2. 둘째 줄\n\n3. 빈 줄 뒤"\n';
	const merged = parseCsv(tab).map((row, i) => (i === 0 ? ["분류", ...row] : ["탭A", ...row]));
	const reparsed = parseCsv(toCsv(merged));
	expect(reparsed[1]?.[0]).toBe("탭A");
	expect(reparsed[1]?.[2]).toBe("1. 첫째 줄\n2. 둘째 줄\n\n3. 빈 줄 뒤");
	expect(toCsv(merged)).not.toContain("탭A,1.");
});

test("ingestCsv applies a mapping override (AI-refined rule.mapping) over auto-detection", () => {
	const csv = "col_a,col_b,col_c\nT1,do the thing,it works\n";
	expect(ingestCsv(csv).unique[0]?.title).toBe(""); // headers don't auto-map
	const over = ingestCsv(csv, { title: "col_a", step: "col_b", expected: "col_c" }).unique[0];
	expect(over?.title).toBe("T1");
	expect(over?.steps).toEqual(["do the thing"]);
	expect(over?.expected).toBe("it works");
});

test("ingestCsv derives category from a 분류 column", () => {
	const csv = "Title,분류,Steps,Expected Result\n로그인 성공,로그인,go,ok\n결재 상신,전자결재,go,ok\n";
	const cases = ingestCsv(csv).unique;
	expect(cases.map((c) => c.category)).toEqual(["로그인", "전자결재"]);
	expect(cases[0]?.title).toBe("로그인 성공");
});

test("ingestCsv falls back to a [말머리] title prefix as category and strips it from the title", () => {
	const csv = "Title,Steps,Expected Result\n[로그인] 잘못된 비밀번호,go,ok\n일반 케이스,go,ok\n";
	const cases = ingestCsv(csv).unique;
	expect(cases[0]?.category).toBe("로그인");
	expect(cases[0]?.title).toBe("잘못된 비밀번호");
	expect(cases[1]?.category).toBe(null);
	expect(cases[1]?.title).toBe("일반 케이스");
});

test("ingestCsv carries what a person already recorded: the QA verdict column and the 비고 note", () => {
	// Read so a reviewer can adjudicate an engine verdict against the sheet's own record without
	// leaving the screen — the pairing `measure` prints to make a disagreement readable in one line.
	const csv = "소분류,시험절차,예상결과,검증 결과,비고\n로그인,1. 로그인,대시보드,Fail,기획서와 상이한 현상\n";
	const m = mapColumns(csvToRawTable(csv).headers);
	expect(m.recordedVerdict).toBe("검증 결과");
	expect(m.note).toBe("비고");
	const tc = ingestCsv(csv).unique[0];
	expect(tc?.recordedVerdict).toBe("Fail");
	expect(tc?.note).toBe("기획서와 상이한 현상");
});

test("a sheet with no verdict column must not have its 예상결과 read as one", () => {
	// Both record columns are matched last, so they can only ever double-claim a column an earlier
	// field already took. Letting that stand would put a fabricated "this is what the human recorded"
	// in front of a reviewer — the one thing this data may never do.
	const m = mapColumns(["소분류", "시험절차", "예상결과"]);
	expect(m.expected).toBe("예상결과");
	expect(m.recordedVerdict).toBeUndefined();
	expect(m.note).toBeUndefined();
	expect(ingestCsv("소분류,시험절차,예상결과\n로그인,1. 로그인,대시보드\n").unique[0]?.recordedVerdict).toBeUndefined();
});

test("the recorded columns stay outside the content hash, so filling a result in never re-ids a case", () => {
	// Same reason `precondition` is excluded: a caseId change orphans every approved baseline, and a
	// QA verdict typed in after the fact is bookkeeping about the case, not what the case verifies.
	const blank = ingestCsv("소분류,시험절차,예상결과,검증 결과,비고\n로그인,1. 로그인,대시보드,,\n").unique[0];
	const filled = ingestCsv("소분류,시험절차,예상결과,검증 결과,비고\n로그인,1. 로그인,대시보드,Fail,깨짐\n").unique[0];
	expect(filled?.caseId).toBe(blank?.caseId as string);
	expect(blank?.recordedVerdict).toBeUndefined();
	expect(filled?.recordedVerdict).toBe("Fail");
});
