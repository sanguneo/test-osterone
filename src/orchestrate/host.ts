/**
 * Host: dispatches scenario jobs to workers and aggregates results. A `Dispatch`
 * is either in-process (`inProcessDispatch`) or over the HTTP worker protocol
 * (`httpDispatch`) — both return the identical `StructuredResult` contract, which
 * the orchestration contract test asserts across the process boundary.
 */

import type { Page } from "../execute/page.ts";
import type { RunEnv, StructuredResult, Verdict } from "../execute/runner.ts";
import { executeJob, type WorkerJob } from "./worker.ts";

export type Dispatch = (job: WorkerJob) => Promise<StructuredResult>;

export function inProcessDispatch(makePage: (env: RunEnv) => Page): Dispatch {
	return (job) => executeJob(job, makePage);
}

export function httpDispatch(baseUrl: string, fetchImpl: typeof fetch = fetch): Dispatch {
	const url = `${baseUrl.replace(/\/$/, "")}/run`;
	return async (job) => {
		const res = await fetchImpl(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(job),
		});
		if (!res.ok) throw new Error(`worker ${res.status}: ${(await res.text()).slice(0, 200)}`);
		return (await res.json()) as StructuredResult;
	};
}

export interface Aggregate {
	total: number;
	byVerdict: Record<Verdict, number>;
	results: StructuredResult[];
}

/** Run jobs across a dispatch with bounded concurrency; results keep input order. */
export async function runScenarios(
	jobs: WorkerJob[],
	dispatch: Dispatch,
	opts: { concurrency?: number } = {},
): Promise<Aggregate> {
	const concurrency = Math.max(1, opts.concurrency ?? 1);
	const results: StructuredResult[] = new Array(jobs.length);
	let next = 0;

	async function pump(): Promise<void> {
		while (true) {
			const i = next++;
			const job = jobs[i];
			if (!job) return;
			results[i] = await dispatch(job);
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, jobs.length)) }, () => pump()));

	const byVerdict: Record<Verdict, number> = { pass: 0, fail: 0, needs_review: 0, error: 0 };
	for (const r of results) byVerdict[r.verdict] += 1;
	return { total: jobs.length, byVerdict, results };
}
