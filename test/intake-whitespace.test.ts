import { expect, test } from "bun:test";
import { toCsv } from "../src/intake/csv.ts";
import { ingestCsv } from "../src/intake/ingest.ts";

test("normalization preserves significant spaces and tabs in test data and expectations", () => {
	const step = 'Enter "a  b\tc" into "Search"';
	const expected = 'The value is "a  b\tc"';
	const csv = toCsv([
		["Title", "Steps", "Expected"],
		["Whitespace", step, expected],
	]);
	const tc = ingestCsv(csv).unique[0];
	expect(tc?.steps).toEqual([step]);
	expect(tc?.expected).toBe(expected);
});

test("cases that differ in significant whitespace cannot be deduplicated", () => {
	const csv = toCsv([
		["Title", "Steps", "Expected"],
		["Whitespace", 'Enter "a  b" into "Search"', "Saved"],
		["Whitespace", 'Enter "a b" into "Search"', "Saved"],
	]);
	expect(ingestCsv(csv).unique).toHaveLength(2);
});
