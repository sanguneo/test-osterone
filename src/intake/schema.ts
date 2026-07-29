/** Core data model for the intake → interpretation pipeline. */

/** A raw spreadsheet as headers + string-keyed rows (source-format agnostic). */
export interface RawTable {
	headers: string[];
	rows: Record<string, string>[];
}

/** Canonical test-case fields the raw sheet is mapped onto. */
export type TcField = "id" | "title" | "step" | "expected" | "priority" | "role" | "env" | "category" | "precondition";

/** A normalized, deduplicated test case with a deterministic content-derived id. */
export interface NormalizedTC {
	/** Deterministic, content-derived id: `TC-${contentHash}`. Stable across runs for identical content. */
	caseId: string;
	/** Original sheet id (if the source had one), else null. */
	sourceId: string | null;
	title: string;
	steps: string[];
	expected: string;
	/**
	 * The starting state the case assumes, verbatim from the sheet ("계정 관리 페이지 내 신규 계정 생성
	 * 버튼 선택된 상태").
	 *
	 * Not part of `contentHash` on purpose. It is not what the case verifies, and folding it in would
	 * change every `caseId` — orphaning every approved baseline in every project. The preparation it
	 * produces is cached under its own text instead, which also means the seven cases that share one
	 * precondition share one plan.
	 */
	precondition?: string;
	priority: string | null;
	role: string | null;
	env: string | null;
	/** In-sheet grouping (from a 분류/category column, or a `[말머리]` title prefix). Null when uncategorized. */
	category: string | null;
	/** sha256 prefix over normalized (title, steps, expected, role, env). Drives caseId + assertion-cache invalidation. */
	contentHash: string;
}
