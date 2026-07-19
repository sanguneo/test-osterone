/**
 * Evidence + execution persistence (sqlite via bun:sqlite). Stores one row per
 * StructuredResult so history, verdict trends, and evidence refs survive across
 * runs. Uses `:memory:` in tests. (Blob evidence — screenshots/DOM — is written by
 * an object store keyed by the content-addressed refs in `evidenceRefs`.)
 */

import { Database } from "bun:sqlite";

import type { StructuredResult } from "../execute/runner.ts";

export interface ExecutionRow {
	executionId: string;
	caseId: string;
	verdict: string;
	confidence: number;
	ruleVersion: number;
	scenarioHash: string;
	evidenceRefs: string[];
	healEvents: string[];
	timingMs: number;
	env: string;
	createdAt: number;
}

export class SqliteEvidenceStore {
	private readonly db: Database;

	constructor(
		path = ":memory:",
		private readonly now: () => number = Date.now,
	) {
		this.db = new Database(path);
		this.db.run(
			`CREATE TABLE IF NOT EXISTS executions (
				execution_id TEXT PRIMARY KEY,
				case_id TEXT NOT NULL,
				verdict TEXT NOT NULL,
				confidence REAL NOT NULL,
				rule_version INTEGER NOT NULL,
				scenario_hash TEXT NOT NULL,
				evidence_refs TEXT NOT NULL,
				heal_events TEXT NOT NULL,
				timing_ms INTEGER NOT NULL,
				env TEXT NOT NULL,
				created_at INTEGER NOT NULL
			)`,
		);
	}

	recordExecution(r: StructuredResult): void {
		this.db
			.query(
				`INSERT OR REPLACE INTO executions
				(execution_id, case_id, verdict, confidence, rule_version, scenario_hash, evidence_refs, heal_events, timing_ms, env, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				r.executionId,
				r.caseId,
				r.verdict,
				r.confidence,
				r.ruleVersion,
				r.scenarioHash,
				JSON.stringify(r.evidenceRefs),
				JSON.stringify(r.healEvents),
				r.timing.ms,
				JSON.stringify(r.env),
				this.now(),
			);
	}

	listExecutions(caseId?: string): ExecutionRow[] {
		const rows = (
			caseId
				? this.db.query("SELECT * FROM executions WHERE case_id = ? ORDER BY created_at DESC").all(caseId)
				: this.db.query("SELECT * FROM executions ORDER BY created_at DESC").all()
		) as Record<string, unknown>[];
		return rows.map((row) => ({
			executionId: String(row.execution_id),
			caseId: String(row.case_id),
			verdict: String(row.verdict),
			confidence: Number(row.confidence),
			ruleVersion: Number(row.rule_version),
			scenarioHash: String(row.scenario_hash),
			evidenceRefs: JSON.parse(String(row.evidence_refs)) as string[],
			healEvents: JSON.parse(String(row.heal_events)) as string[],
			timingMs: Number(row.timing_ms),
			env: String(row.env),
			createdAt: Number(row.created_at),
		}));
	}

	close(): void {
		this.db.close();
	}
}
