/**
 * Triage: split cases into automatable vs human-required BEFORE execution.
 * Deterministic baseline classifier; an LLM pass may later refine via the same
 * `TriageDecision` shape. Selection accuracy vs human labels is a v1 hard gate.
 */

import type { NormalizedTC } from "../intake/schema.ts";

export interface TriageDecision {
	caseId: string;
	automatable: boolean;
	reason: string;
	signals: string[];
}

/** Signals that a case needs human judgment or a manual / out-of-browser step. */
export const HUMAN_SIGNALS: string[] = [
	"captcha",
	"otp",
	"one-time",
	"2fa",
	"two-factor",
	"sms",
	"phone call",
	"email received",
	"check your email",
	"verify email",
	"confirmation email",
	"manually",
	"by hand",
	"visually inspect",
	"looks correct",
	"aesthetic",
	"subjective",
	"human review",
	"physical",
	"scan the",
	"print",
	"camera",
	"microphone",
	"biometric",
	"fingerprint",
	"face id",
	"real device",
	"approve in person",
];

/** Deterministic baseline triage of a single case. */
export function triageDeterministic(tc: NormalizedTC): TriageDecision {
	const hay = [tc.title, tc.expected, ...tc.steps].join("\n").toLowerCase();
	const signals = HUMAN_SIGNALS.filter((s) => hay.includes(s));
	if (tc.steps.length === 0) {
		return { caseId: tc.caseId, automatable: false, reason: "no executable steps", signals };
	}
	if (signals.length > 0) {
		return {
			caseId: tc.caseId,
			automatable: false,
			reason: `human-required signals: ${signals.join(", ")}`,
			signals,
		};
	}
	return {
		caseId: tc.caseId,
		automatable: true,
		reason: "no human-judgment signals; steps are browser-actionable",
		signals,
	};
}

/** Split a case list into automatable vs human-required (input order preserved). */
export function triageAll(tcs: NormalizedTC[]): {
	automatable: NormalizedTC[];
	humanRequired: NormalizedTC[];
	decisions: TriageDecision[];
} {
	const decisions = tcs.map(triageDeterministic);
	const automatable: NormalizedTC[] = [];
	const humanRequired: NormalizedTC[] = [];
	tcs.forEach((tc, i) => {
		if (decisions[i]?.automatable) {
			automatable.push(tc);
		} else {
			humanRequired.push(tc);
		}
	});
	return { automatable, humanRequired, decisions };
}
