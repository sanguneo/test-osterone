import { expect, test } from "bun:test";
import { evaluateAssertion } from "../src/interpret/assertion.ts";
import { requirementCoverage } from "../src/interpret/interpret.ts";
import { matchRoute } from "../src/interpret/route-match.ts";

const routes = [{ label: "대시보드", path: "/dashboard" }];

test("a navigation check covers only the required observed destination", () => {
	const expected = "대시보드로 이동되어야 한다.";
	expect(requirementCoverage(expected, [{ kind: "urlIncludes", value: "/dashboard" }], { routes })?.covered).toBe(1);
	expect(requirementCoverage(expected, [{ kind: "urlIncludes", value: "/other" }], { routes })?.covered).toBe(0);
	expect(requirementCoverage(expected, [{ kind: "urlIncludes", value: "/dashboard" }])?.covered).toBe(0);
	expect(
		requirementCoverage("대시보드로 이동하지 않아야 한다.", [{ kind: "urlIncludes", value: "/dashboard" }], { routes })
			?.covered,
	).toBe(0);
});

test("a literal expected path is attributable without inventing a route", () => {
	expect(requirementCoverage("/dashboard", [{ kind: "urlIncludes", value: "/dashboard" }])?.covered).toBe(1);
	expect(requirementCoverage("/dashboard", [{ kind: "urlIncludes", value: "/" }])?.covered).toBe(0);
});

test("path assertions cannot pass on a return URL or a similarly named path", () => {
	const check = (url: string) =>
		evaluateAssertion({ kind: "urlIncludes", value: "/dashboard" }, { url, text: "", html: "" }).passed;
	expect(check("https://app.test/login?returnUrl=/dashboard")).toBe(false);
	expect(check("https://app.test/dashboard-old")).toBe(false);
	expect(check("https://app.test/dashboard")).toBe(true);
	expect(check("https://app.test/dashboard/list")).toBe(true);
});

test("observed route resolution chooses the longest label independently of input order", () => {
	const entries = [
		{ label: "기관 관리", path: "/agency" },
		{ label: "전체 기관 관리", path: "/all-agencies" },
	];
	expect(matchRoute("전체 기관 관리로 이동", entries)?.path).toBe("/all-agencies");
	expect(
		matchRoute("기관 관리로 이동", [
			{ label: "기관 관리", path: "/a" },
			{ label: "기관 관리", path: "/b" },
		]),
	).toBeNull();
});
