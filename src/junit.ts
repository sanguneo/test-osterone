/**
 * JUnit XML report from StructuredResults (deferred / in-scope integration output).
 * verdict mapping: pass -> ok, fail -> <failure>, error -> <error>, needs_review -> <skipped>.
 */

import type { StructuredResult } from "./runner.ts";

function esc(s: string): string {
	return s.replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] ?? c,
	);
}

export function toJUnitXml(results: StructuredResult[], suiteName = "test-osterone"): string {
	const failures = results.filter((r) => r.verdict === "fail").length;
	const errors = results.filter((r) => r.verdict === "error").length;
	const skipped = results.filter((r) => r.verdict === "needs_review").length;
	const cases = results
		.map((r) => {
			const time = (r.timing.ms / 1000).toFixed(3);
			let inner = "";
			if (r.verdict === "fail") inner = `<failure message="assertions failed (confidence ${r.confidence})"/>`;
			else if (r.verdict === "error") inner = `<error message="${esc(r.errorInfo ?? "error")}"/>`;
			else if (r.verdict === "needs_review") inner = `<skipped message="needs review"/>`;
			return `  <testcase name="${esc(r.caseId)}" classname="${esc(r.env.baseUrl)}" time="${time}">${inner}</testcase>`;
		})
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${esc(suiteName)}" tests="${results.length}" failures="${failures}" errors="${errors}" skipped="${skipped}">\n${cases}\n</testsuite>\n`;
}
