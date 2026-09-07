/** Core data model for the intake → interpretation pipeline. */

/** A raw spreadsheet as headers + string-keyed rows (source-format agnostic). */
export interface RawTable {
	headers: string[];
	rows: Record<string, string>[];
	/** Unique physical-column keys for repeated header names. */
	columnGroups?: Record<string, string[]>;
	/** Row indexes preceded by a blank record or repeated header; continuation cannot cross these. */
	rowBreaks?: number[];
}

/** Canonical test-case fields the raw sheet is mapped onto. */
export type TcField =
	| "id"
	| "title"
	| "step"
	| "expected"
	| "priority"
	| "role"
	| "env"
	| "category"
	| "precondition"
	| "recordedVerdict"
	| "note";

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
	 * Part of case identity when present: identical actions under different starting conditions
	 * are different tests and must not share an approved baseline. Preparation plans still share
	 * their own text-keyed cache when multiple cases have the same starting condition.
	 */
	precondition?: string;
	/**
	 * What a person already recorded for this case, verbatim from the sheet: the QA verdict column
	 * ("검증 결과" → Pass/Fail) and the defect note beside it ("비고").
	 *
	 * Carried so a reviewer can adjudicate an engine verdict against the sheet's own record without
	 * leaving the screen — the same pairing `measure` prints, which is what makes a disagreement
	 * readable in one line ("사람 Fail · 엔진 pass · 비고: 기획서와 상이").
	 *
	 * Outside `contentHash`: this is bookkeeping about a case, not its execution context or what
	 * it verifies. Filling in a result must not change the case identity.
	 */
	recordedVerdict?: string;
	note?: string;
	priority: string | null;
	role: string | null;
	env: string | null;
	/** In-sheet grouping (from a 분류/category column, or a `[말머리]` title prefix). Null when uncategorized. */
	category: string | null;
	/** sha256 prefix over normalized content plus category/precondition when present. Context-free legacy IDs are preserved. */
	contentHash: string;
}
