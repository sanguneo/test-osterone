/**
 * Golden baseline lifecycle for visual/ambiguous cases: propose -> human approve
 * -> diff. Diffs run on a MASKED snapshot (dynamic regions like timestamps/uuids
 * redacted) so re-runs are deterministic. An unapproved or missing baseline gates
 * to needs_review; an approved-but-drifted baseline also gates to needs_review —
 * never a silent pass. (Screenshot pixel-diff is the BrowserPage extension of this
 * same masked-diff contract.)
 */

export const DEFAULT_MASKS: RegExp[] = [
	/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(:\d{2})?/gi, // ISO-ish timestamps
	/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, // uuid
	/\b\d{6,}\b/g, // long digit runs (epochs, ids)
];

export function maskDynamic(text: string, masks: RegExp[] = DEFAULT_MASKS): string {
	let out = text;
	for (const re of masks) out = out.replace(re, "\u27e6MASK\u27e7");
	return out;
}

export interface Baseline {
	caseId: string;
	ruleVersion: number;
	env: string;
	maskedText: string;
	approved: boolean;
	createdAt: number;
}

export type BaselineGate =
	| { status: "no_baseline"; reason: string }
	| { status: "unapproved"; reason: string }
	| { status: "match" }
	| { status: "drift"; baselineMasked: string; currentMasked: string };

export function baselineKey(caseId: string, ruleVersion: number, env: string): string {
	return `${caseId}|v${ruleVersion}|${env}`;
}

export class MemoryBaselineStore {
	private readonly store = new Map<string, Baseline>();

	constructor(private readonly now: () => number = Date.now) {}

	get(caseId: string, ruleVersion: number, env: string): Baseline | undefined {
		return this.store.get(baselineKey(caseId, ruleVersion, env));
	}

	/** Record a pending (unapproved) baseline from a snapshot's text. */
	propose(
		caseId: string,
		ruleVersion: number,
		env: string,
		snapshotText: string,
		masks: RegExp[] = DEFAULT_MASKS,
	): Baseline {
		const baseline: Baseline = {
			caseId,
			ruleVersion,
			env,
			maskedText: maskDynamic(snapshotText, masks),
			approved: false,
			createdAt: this.now(),
		};
		this.store.set(baselineKey(caseId, ruleVersion, env), baseline);
		return baseline;
	}

	approve(caseId: string, ruleVersion: number, env: string): void {
		const key = baselineKey(caseId, ruleVersion, env);
		const b = this.store.get(key);
		if (!b) throw new Error(`no baseline to approve: ${key}`);
		this.store.set(key, { ...b, approved: true });
	}

	/** Gate a current snapshot against the stored baseline. */
	gate(
		caseId: string,
		ruleVersion: number,
		env: string,
		currentText: string,
		masks: RegExp[] = DEFAULT_MASKS,
	): BaselineGate {
		const b = this.get(caseId, ruleVersion, env);
		if (!b) {
			this.propose(caseId, ruleVersion, env, currentText, masks);
			return { status: "no_baseline", reason: "proposed a pending baseline; awaiting human approval" };
		}
		if (!b.approved) return { status: "unapproved", reason: "baseline exists but is not approved" };
		const currentMasked = maskDynamic(currentText, masks);
		if (currentMasked === b.maskedText) return { status: "match" };
		return { status: "drift", baselineMasked: b.maskedText, currentMasked };
	}
}
