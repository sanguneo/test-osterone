import { selfHealPrefix, useLang } from "../i18n";
import type { Lang } from "../i18n";
import type { Verdict } from "../types";
import { Icon } from "./Icon";

export function vLabel(v: Verdict, lang: Lang): string {
	const ko = { pass: "통과", fail: "실패", needs_review: "리뷰 필요", error: "오류" } as const;
	const en = { pass: "Pass", fail: "Fail", needs_review: "Review", error: "Error" } as const;
	return (lang === "en" ? en : ko)[v];
}

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
	const lang = useLang();
	return (
		<span className="vmark">
			<span className={`vdot ${verdict}`} />
			{vLabel(verdict, lang)}
		</span>
	);
}

/** One chip per verdict with its count, for run summaries. */
export function VerdictCounts({ counts }: { counts: Record<Verdict, number> }) {
	const lang = useLang();
	return (
		<>
			{VERDICTS.map((v) => (
				<span className="chip" style={{ color: V_COLOR[v] }} key={v}>
					{vLabel(v, lang)} <b>{counts[v] || 0}</b>
				</span>
			))}
		</>
	);
}

/** Self-heal warning line under a case row; renders nothing when no healing happened. */
export function SelfHealNote({ heal }: { heal: string[] }) {
	const lang = useLang();
	if (heal.length === 0) return null;
	return <div className="heal"><Icon name="warning" size={14} /> {selfHealPrefix(lang)}: {stripAnsi(heal.join("; "))}</div>;
}
