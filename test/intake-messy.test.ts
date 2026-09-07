import { expect, test } from "bun:test";
import { csvToRawTable, ingestCsv, mapColumns, parseCsv } from "../src/intake/ingest.ts";

for (const delimiter of [";", "\t"]) {
	test(`ingests ${JSON.stringify(delimiter)}-delimited records with quoted delimiters and newlines`, () => {
		const csv = [
			["ID", "Title", "Steps", "Expected"].join(delimiter),
			["1", "Login", '"Open Login\nClick Submit"', `"Ready${delimiter} done"`].join(delimiter),
		].join("\n");
		const tc = ingestCsv(csv).unique[0];
		expect(tc?.sourceId).toBe("1");
		expect(tc?.title).toBe("Login");
		expect(tc?.steps).toEqual(["Open Login", "Click Submit"]);
		expect(tc?.expected).toBe(`Ready${delimiter} done`);
	});
}

test("recognizes Excel sep declarations and a BOM", () => {
	const csv = '\uFEFFsep=;\r\nID;Title;Steps;Expected\r\n1;Login;"Click Submit";Dashboard';
	expect(ingestCsv(csv).unique[0]?.title).toBe("Login");
});

test("literal quotes in unquoted prose do not absorb subsequent records", () => {
	expect(parseCsv('Title,Steps\nLogin,Click the 6" control\nLogout,Click Exit')).toEqual([
		["Title", "Steps"],
		["Login", 'Click the 6" control'],
		["Logout", "Click Exit"],
	]);
});

test("rejects a truncated quoted cell rather than importing a partial expectation", () => {
	expect(() => parseCsv('Title,Expected\nLogin,"first\nsecond')).toThrow(/quote/i);
});

test("finds the header below a banner and preserves both cases", () => {
	const csv =
		"Regression Suite,,,\nRelease 4,,,\nID,Title,Steps,Expected\n1,Login,Click Login,Dashboard\n2,Logout,Click Logout,Login screen";
	expect(csvToRawTable(csv).headers).toEqual(["ID", "Title", "Steps", "Expected"]);
	expect(ingestCsv(csv).unique.map((tc) => tc.title)).toEqual(["Login", "Logout"]);
});

test("combines parent and child header bands without importing a child header as a case", () => {
	const csv = "ID,Test Case,,Expected\n,Title,Steps,\n1,Login,Click Submit,Dashboard";
	const tcs = ingestCsv(csv).unique;
	expect(tcs).toHaveLength(1);
	expect(tcs[0]?.sourceId).toBe("1");
	expect(tcs[0]?.title).toBe("Login");
	expect(tcs[0]?.steps).toEqual(["Click Submit"]);
	expect(tcs[0]?.expected).toBe("Dashboard");
});

test("duplicate and blank headers preserve every physical column", () => {
	const table = csvToRawTable("ID,Title,Steps,Steps,,\n1,Login,Open Login,Click Submit,Left,Right");
	expect(new Set(table.headers).size).toBe(6);
	expect(Object.values(table.rows[0] ?? {})).toEqual(["1", "Login", "Open Login", "Click Submit", "Left", "Right"]);
	expect(
		ingestCsv("ID,Title,Steps,Steps,Expected\n1,Login,Open Login,Click Submit,Dashboard").unique[0]?.steps,
	).toEqual(["Open Login", "Click Submit"]);
});

test("header keys cannot shadow row object properties", () => {
	const table = csvToRawTable("Title,Steps,Expected,__proto__\nLogin,Click Submit,Dashboard,Retained");
	expect(Object.hasOwn(table.rows[0] ?? {}, "__proto__")).toBe(true);
	expect(Object.getOwnPropertyDescriptor(table.rows[0] ?? {}, "__proto__")?.value).toBe("Retained");
});

test("folds vertically merged case IDs and titles into one ordered procedure", () => {
	const csv =
		"ID,Title,Steps,Expected\n1,Login,Open Login,\n,,Enter credentials,\n,,Click Submit,Dashboard\n2,Logout,Click Logout,Login screen";
	const tcs = ingestCsv(csv).unique;
	expect(tcs).toHaveLength(2);
	expect(tcs[0]?.steps).toEqual(["Open Login", "Enter credentials", "Click Submit"]);
	expect(tcs[0]?.expected).toBe("Dashboard");
});

test("folds adjacent step records with the same explicit case ID", () => {
	const csv = "ID,Title,Steps,Expected\n1,Login,Open Login,Form\n1,Login,Click Submit,Dashboard";
	const tcs = ingestCsv(csv).unique;
	expect(tcs).toHaveLength(1);
	expect(tcs[0]?.steps).toEqual(["Open Login", "Click Submit"]);
	expect(tcs[0]?.expected).toBe("Form\nDashboard");
});

test("does not fold independently titled cases, conflicting context, or exact repeated cases", () => {
	const csv =
		"ID,Title,Steps,Expected,Category,Precondition\n1,Login,Open Login,Form,A,Empty\n1,Login,Open Login,Form,A,Empty\n1,Login,Click Submit,Dashboard,B,Empty\n,Logout,Click Logout,Login screen,B,Empty\n1,Login,Click Submit,Dashboard,B,Filled";
	expect(ingestCsv(csv).all).toHaveLength(5);
});

test("blank rows and repeated header rows break continuation groups", () => {
	for (const separator of [",,,", "ID,Title,Steps,Expected"]) {
		const csv = `ID,Title,Steps,Expected\n1,Login,Open Login,\n${separator}\n,,Click Submit,Dashboard`;
		const tcs = ingestCsv(csv).all;
		expect(tcs).toHaveLength(2);
		expect(tcs[0]?.steps).toEqual(["Open Login"]);
		expect(tcs[1]?.steps).toEqual(["Click Submit"]);
	}
});

test("does not infer continuation groups without an explicit case ID", () => {
	const csv = "Title,Steps,Expected\nLogin,Open Login,Form\n,Click Submit,Dashboard";
	expect(ingestCsv(csv).all).toHaveLength(2);
});

test("maps an actual procedure before prerequisite steps and avoids incidental short aliases", () => {
	expect(mapColumns(["Case Name", "Prerequisite Steps", "Procedure", "Expected"]).step).toBe("Procedure");
	expect(mapColumns(["Title", "Steps", "Expected", "Notes"]).id).toBeUndefined();
});

test("keeps the procedure preference for Korean compound headers", () => {
	expect(mapColumns(["소분류", "사전조건", "상세 시험절차", "예상결과"]).step).toBe("상세 시험절차");
});

test("continuation with repeated procedure columns preserves row-major action order", () => {
	const csv =
		"ID,Title,Steps,Steps,Expected\n1,Login,Open Login,Enter user,\n1,Login,Enter password,Click Submit,Dashboard";
	expect(ingestCsv(csv).unique[0]?.steps).toEqual(["Open Login", "Enter user", "Enter password", "Click Submit"]);
});

test("stale mapping overrides cannot erase auto-detected case content", () => {
	const csv = "ID,Title,Steps,Expected\n1,Login,Click Submit,Dashboard";
	const tc = ingestCsv(csv, { title: "Old Title", step: "Old Steps", expected: "Old Expected" }).unique[0];
	expect(tc?.title).toBe("Login");
	expect(tc?.steps).toEqual(["Click Submit"]);
	expect(tc?.expected).toBe("Dashboard");
});

test("unknown headers retain raw rows for later explicit mapping", () => {
	const csv = "a,b,c\n1,Do first,First result\n2,Do second,Second result";
	expect(csvToRawTable(csv).rows).toHaveLength(2);
	expect(ingestCsv(csv, { id: "a", step: "b", expected: "c" }).unique).toHaveLength(2);
});

test("different preconditions are distinct cases and invalidate old case identities", () => {
	const csv =
		"ID,Title,Steps,Expected,Precondition\n1,Submit,Click Submit,Validation error,Form is empty\n2,Submit,Click Submit,Validation error,Invalid email entered";
	const cases = ingestCsv(csv).unique;
	expect(cases).toHaveLength(2);
	expect(cases[0]?.caseId).not.toBe(cases[1]?.caseId);
	const legacy = ingestCsv("ID,Title,Steps,Expected\n1,Submit,Click Submit,Validation error").unique[0];
	expect(cases[0]?.caseId).not.toBe(legacy?.caseId);
});

test("different workbook categories and title prefixes cannot deduplicate each other", () => {
	for (const csv of [
		"ID,Title,Steps,Expected,Category\n1,Delete,Click Delete,Confirmation,Admin\n1,Delete,Click Delete,Confirmation,Sender",
		"Title,Steps,Expected\n[Users] Delete,Click Delete,Confirmation\n[Groups] Delete,Click Delete,Confirmation",
	]) {
		const cases = ingestCsv(csv).unique;
		expect(cases).toHaveLength(2);
		expect(cases[0]?.caseId).not.toBe(cases[1]?.caseId);
	}
});

test("legacy identity stays stable when no category or precondition exists", () => {
	const csv = "ID,Title,Steps,Expected,Category,Precondition\n1,Login,Click Login,Dashboard,,";
	expect(ingestCsv(csv).unique[0]?.caseId).toBe("TC-b239afeb4ce987d9");
});
