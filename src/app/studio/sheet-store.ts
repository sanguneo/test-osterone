/**
 * Per-sheet CSV content storage. Studio projects.json keeps only sheet metadata;
 * the (potentially large) csvText for each CSV sheet lives in its own file under
 * ~/.test-osterone/sheet-data/<projectId>/<sheetId>.csv so persisting/loading the
 * project list stays cheap regardless of how many sheets a project has.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where per-sheet CSV content files live. Overridable via env for hermetic tests. */
export function sheetDataDir(): string {
	return process.env.TEST_OSTERONE_SHEETDATA_DIR?.trim() || join(homedir(), ".test-osterone", "sheet-data");
}

/** Sanitize a path segment so it can never escape `baseDir` (no slashes/dots-as-separators). */
function safe(part: string): string {
	return part.replace(/[^a-zA-Z0-9_-]/g, "_") || "_";
}

function sheetFile(baseDir: string, projectId: string, sheetId: string): string {
	return join(baseDir, safe(projectId), `${safe(sheetId)}.csv`);
}

/** Write a sheet's CSV content to disk, creating the project's directory as needed. */
export function writeSheetContent(projectId: string, sheetId: string, csvText: string, baseDir = sheetDataDir()): void {
	mkdirSync(join(baseDir, safe(projectId)), { recursive: true });
	writeFileSync(sheetFile(baseDir, projectId, sheetId), csvText);
}

/** Read a sheet's CSV content from disk; "" if it doesn't exist. */
export function readSheetContent(projectId: string, sheetId: string, baseDir = sheetDataDir()): string {
	try {
		return readFileSync(sheetFile(baseDir, projectId, sheetId), "utf8");
	} catch {
		return "";
	}
}

/** Remove one sheet's persisted CSV content (e.g. the sheet was deleted). */
export function deleteSheetContent(projectId: string, sheetId: string, baseDir = sheetDataDir()): void {
	rmSync(sheetFile(baseDir, projectId, sheetId), { force: true });
}

/** Remove all of a project's persisted sheet content (e.g. the project was deleted). */
export function deleteProjectSheets(projectId: string, baseDir = sheetDataDir()): void {
	rmSync(join(baseDir, safe(projectId)), { recursive: true, force: true });
}
