import type { Verdict } from "../types";
import { Icon } from "./Icon";

export const V_LABEL: Record<Verdict, string> = { pass: "통과", fail: "실패", needs_review: "리뷰 필요", error: "오류" };

const V_COLOR: Record<Verdict, string> = {
	pass: "var(--pass)",
	fail: "var(--fail)",
	needs_review: "var(--review)",
	error: "var(--error)",
};

const VERDICTS: Verdict[] = ["pass", "fail", "needs_review", "error"];

/** Playwright error strings carry ANSI color codes; strip them before display. */
export const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

/** Verdict as a 6px status dot + label — the app-wide standard (dots, not badges). */
export function VerdictMark({ verdict }: { verdict: Verdict }) {
	return (
		<span className="vmark">
			<span className={`vdot ${verdict}`} />
			{V_LABEL[verdict]}
		</span>
	);
}

/** One chip per verdict with its count, for run summaries. */
export function VerdictCounts({ counts }: { counts: Record<Verdict, number> }) {
	return (
		<>
			{VERDICTS.map((v) => (
				<span className="chip" style={{ color: V_COLOR[v] }} key={v}>
					{V_LABEL[v]} <b>{counts[v] || 0}</b>
				</span>
			))}
		</>
	);
}

/** Self-heal warning line under a case row; renders nothing when no healing happened. */
export function SelfHealNote({ heal }: { heal: string[] }) {
	if (heal.length === 0) return null;
	return <div className="heal"><Icon name="warning" size={14} /> self-heal: {stripAnsi(heal.join("; "))}</div>;
}
