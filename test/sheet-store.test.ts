import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	deleteProjectSheets,
	deleteSheetContent,
	readSheetContent,
	writeSheetContent,
} from "../src/app/studio/sheet-store.ts";

const dir = mkdtempSync(join(tmpdir(), "osterone-sheetdata-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("write then read round-trips the exact csvText", () => {
	writeSheetContent("proj1", "sheetA", "a,b,c\n1,2,3\n", dir);
	expect(readSheetContent("proj1", "sheetA", dir)).toBe("a,b,c\n1,2,3\n");
});

test("readSheetContent returns empty string for a missing file", () => {
	expect(readSheetContent("no-such-project", "no-such-sheet", dir)).toBe("");
});

test("deleteSheetContent removes one sheet's file", () => {
	writeSheetContent("proj2", "sheetA", "data-a", dir);
	writeSheetContent("proj2", "sheetB", "data-b", dir);
	deleteSheetContent("proj2", "sheetA", dir);
	expect(readSheetContent("proj2", "sheetA", dir)).toBe("");
	expect(readSheetContent("proj2", "sheetB", dir)).toBe("data-b");
});

test("deleteProjectSheets removes the whole project directory", () => {
	writeSheetContent("proj3", "sheetA", "data-a", dir);
	writeSheetContent("proj3", "sheetB", "data-b", dir);
	deleteProjectSheets("proj3", dir);
	expect(readSheetContent("proj3", "sheetA", dir)).toBe("");
	expect(readSheetContent("proj3", "sheetB", dir)).toBe("");
});

test("filename safety: slashes/dots in ids can't escape baseDir", () => {
	writeSheetContent("p/../x", "s.1", "data", dir);
	expect(readSheetContent("p/../x", "s.1", dir)).toBe("data");
});
