import { formatAssertion, useLang } from "../i18n";
import type { KeyboardEvent } from "react";
import type { CaseView } from "../types";
import { SelfHealNote, stripAnsi, VerdictMark } from "./Verdict";

const S = {
	ko: { review: "리뷰 →" },
	en: { review: "Review →" },
} as const;

const EMPTY_CELLS = [0, 1, 2, 3, 4, 5, 6, 7, 8];

export function Spark({ rates }: { readonly rates: number[] }) {
	if (rates.length < 2) return null;
	const width = 120;
	const height = 32;
	const min = Math.min(...rates);
	const max = Math.max(...rates);
	const span = max - min;
	const points = rates.map((rate, index) => {
		const x = (index / (rates.length - 1)) * width;
		const y = span === 0 ? height / 2 : 3 + (1 - (rate - min) / span) * (height - 6);
		return `${x.toFixed(1)},${y.toFixed(1)}`;
	});
	return (
		<svg className="spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
			<defs><linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--lime)" stopOpacity="0.15" /><stop offset="1" stopColor="var(--lime)" stopOpacity="0" /></linearGradient></defs>
			<polygon fill="url(#sparkfill)" points={`0,${height} ${points.join(" ")} ${width},${height}`} />
			<polyline fill="none" stroke="var(--lime)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" points={points.join(" ")} />
			<path d={`M ${(points[points.length - 1] ?? "").replace(",", " ")} l 0.01 0`} stroke="var(--lime)" strokeWidth="5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
		</svg>
	);
}

export function EmptyMotif() {
	return (
		<svg width="96" height="96" viewBox="0 0 96 96" aria-hidden="true">
			{EMPTY_CELLS.map((index) => <rect key={index} x={6 + (index % 3) * 30} y={6 + Math.floor(index / 3) * 30} width="24" height="24" rx="6" fill={index === 4 ? "var(--lime-soft)" : "none"} stroke={index === 4 ? "var(--lime)" : "var(--line)"} strokeWidth="1.5" />)}
			<path d="M42 48 l4 4 l8 -8" fill="none" stroke="var(--lime)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

export function DashboardSkeleton() {
	return (
		<div className="late">
			<div className="metrics">{[0, 1, 2, 3].map((index) => <div className="metric" key={index}><div className="skel" style={{ width: 90, height: 12 }} /><div className="skel" style={{ width: 70, height: index === 0 ? 34 : 26, marginTop: 8 }} /><div className="skel" style={{ width: 110, height: 11, marginTop: 8 }} />{index === 0 && <div className="skel" style={{ height: 32, marginTop: 10 }} />}</div>)}</div>
			<div className="card">{[0, 1, 2, 3, 4].map((index) => <div className="skel" style={{ height: 20, marginTop: index === 0 ? 0 : 14 }} key={index} />)}</div>
		</div>
	);
}

export function DashboardQueueRow({ result, onKey, goReview }: { readonly result: CaseView; readonly onKey: (event: KeyboardEvent<HTMLTableRowElement>) => void; readonly goReview: () => void }) {
	const firstFail = result.assertions.find((assertion) => !assertion.passed);
	const lang = useLang();
	return (
		<tr tabIndex={0} onKeyDown={onKey}>
			<td className="ttl">{result.category && <span className="cat-tag">{result.category}</span>}{result.title || result.caseId}</td><td><VerdictMark verdict={result.verdict} /></td><td className="num">{result.passed}/{result.total}</td><td className="num">{result.confidence.toFixed(2)}</td>
			<td>{firstFail && <div className="detail">{stripAnsi(formatAssertion(firstFail, lang))}</div>}<SelfHealNote heal={result.heal} />{result.verdict === "needs_review" && <button className="linkbtn" type="button" onClick={goReview}>{S[lang].review}</button>}</td>
		</tr>
	);
}
