/** Core data model for the intake → interpretation pipeline. */

/** A raw spreadsheet as headers + string-keyed rows (source-format agnostic). */
export interface RawTable {
	headers: string[];
	rows: Record<string, string>[];
}

/** Canonical test-case fields the raw sheet is mapped onto. */
export type TcField = "id" | "title" | "step" | "expected" | "priority" | "role" | "env" | "category";

/** A normalized, deduplicated test case with a deterministic content-derived id. */
export interface NormalizedTC {
	/** Deterministic, content-derived id: `TC-${contentHash}`. Stable across runs for identical content. */
	caseId: string;
	/** Original sheet id (if the source had one), else null. */
	sourceId: string | null;
	title: string;
	steps: string[];
	expected: string;
	priority: string | null;
	role: string | null;
	env: string | null;
	/** In-sheet grouping (from a 분류/category column, or a `[말머리]` title prefix). Null when uncategorized. */
	category: string | null;
	/** sha256 prefix over normalized (title, steps, expected, role, env). Drives caseId + assertion-cache invalidation. */
	contentHash: string;
}
