import { describe, expect, test } from "bun:test";
import { ingestCsv } from "../src/intake/ingest.ts";
import type { NormalizedTC } from "../src/intake/schema.ts";
import { establishRuleFromHeaders } from "../src/interpret/rule.ts";
import { assertionLine, exportE2E, slugFromSource, suitePackageJson } from "../src/report/e2e-export.ts";

const HEADERS = ["번호", "시험항목", "시험절차", "예상결과"];
const rule = establishRuleFromHeaders(HEADERS);

function csvCell(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}

/** Cases through the real intake, so steps and ids are exactly what a sheet produces. */
function cases(rows: [string, string, string[], string][]): NormalizedTC[] {
	const lines = [HEADERS.join(",")];
	for (const [id, title, steps, expected] of rows) {
		lines.push([id, title, steps.join("\n"), expected].map(csvCell).join(","));
	}
	return ingestCsv(lines.join("\n")).unique;
}

const LOGIN = ["open /", 'enter "admin" into "Username"', 'enter "secret" into "Password"', 'click "Log in"'];

function suite(tcs: NormalizedTC[], agentSteps = false) {
	const result = exportE2E(tcs, rule, { slug: "qc", agentSteps });
	const file = (path: string) => result.files.find((f) => f.path === path)?.content ?? "";
	return { ...result, config: file("e2e.config.ts"), tests: file("tests/qc.e2e.ts") };
}

describe("exportE2E mapping", () => {
	const { tests, summary } = suite(
		cases([["TC1", "Valid login", [...LOGIN, 'verify page shows "Welcome"'], "Welcome, admin. Dashboard loaded."]]),
	);

	test("goto, fill and click map to app.open, a label locator and a named tap", () => {
		expect(summary).toEqual([{ caseId: expect.any(String), sourceId: "TC1", mode: "deterministic" }]);
		expect(tests).toContain('test("TC1 Valid login", async ({ app, screen, browser }) => {');
		expect(tests).toContain('\tawait app.open("/");');
		expect(tests).toContain('\tawait screen.getByLabel("Username").fill("admin");');
		expect(tests).toContain('\tawait screen.getByLabel("Password").fill("secret");');
		expect(tests).toContain(
			'\tawait tapNamed([screen.getByRole("button", "Log in"), screen.getByRole("link", "Log in"), screen.getByText("Log in")]);',
		);
	});

	test("text checks become visible-text assertions on a case-sensitive literal", () => {
		expect(tests).toContain("\tawait expect(screen.getByText(/Welcome/, { visible: true }).first()).toBeVisible();");
		expect(tests).toContain(
			"\tawait expect(screen.getByText(/Welcome,\\s+admin\\.\\s+Dashboard\\s+loaded\\./, { visible: true }).first()).toBeVisible();",
		);
	});

	test("a check that already held before the first interaction skips as needs_review", () => {
		expect(tests).toContain("\tlet before = await readScreen(browser);");
		expect(tests).toContain(
			'\ttest.skip(heldBefore(before, [{ text: "Welcome" }, { text: "Welcome, admin. Dashboard loaded." }]), "needs_review:',
		);
	});

	test("absence and url checks", () => {
		expect(assertionLine({ kind: "textNotIncludes", value: "Error" })).toBe(
			"await expect(screen.getByText(/Error/, { visible: true }).first()).not.toBeVisible();",
		);
		expect(assertionLine({ kind: "urlIncludes", value: "/dashboard" })).toBe(
			"await expect(browser).toHaveURL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\\/\\/[^\\/?#]*\\/dashboard(?:\\/[^?#]*)?(?:[?#].*)?$/);",
		);
		expect(assertionLine({ kind: "fieldAtMost", field: "ID", max: 12 })).toBeNull();
	});

	test("the url regex matches the engine's path semantics", () => {
		const literal = assertionLine({ kind: "urlIncludes", value: "/dashboard" })?.match(/toHaveURL\(\/(.*)\/\);$/)?.[1];
		const re = new RegExp(literal?.replace(/\\\//g, "/") ?? "^$");
		expect(re.test("http://127.0.0.1:3000/dashboard")).toBe(true);
		expect(re.test("http://127.0.0.1:3000/dashboard/team?x=1")).toBe(true);
		expect(re.test("http://127.0.0.1:3000/dashboards")).toBe(false);
		expect(re.test("http://127.0.0.1:3000/login?next=/dashboard")).toBe(false);
	});
});

describe("HELD (false-pass = 0)", () => {
	test("an unparseable step is skipped with a needs_review reason, never a runnable test", () => {
		const { tests, summary } = suite(cases([["TC9", "Odd step", ["open /", "wiggle the mouse"], "Done"]]));
		expect(summary[0]).toMatchObject({ sourceId: "TC9", mode: "held" });
		expect(summary[0]?.reason).toBe('needs_review: step 2 cannot be parsed by the rule: "wiggle the mouse"');
		expect(tests).toContain(
			'test("TC9 Odd step", { skip: "needs_review: step 2 cannot be parsed by the rule: \\"wiggle the mouse\\"" }, async () => {});',
		);
		expect(tests).not.toContain("agent.");
	});

	test("a case whose expected result is prose has no deterministic assertion and is held", () => {
		const { summary, tests } = suite(cases([["TC8", "Popup", ["open /", 'click "Help"'], "팝업이 표출되어야 한다."]]));
		expect(summary[0]?.mode).toBe("held");
		expect(summary[0]?.reason).toBe("needs_review: the expected result has no deterministic assertion");
		expect(tests).not.toContain("toBeVisible");
	});

	test("a verify step with nothing checkable holds the case", () => {
		const { summary } = suite(cases([["TC7", "Colour", ["open /", "verify the badge is green"], "OK"]]));
		expect(summary[0]?.reason).toBe(
			'needs_review: verify step 2 has no deterministic assertion: "verify the badge is green"',
		);
	});

	test("--agent-steps drives an unparseable step with agent.act but keeps deterministic verdicts", () => {
		const { tests, config, summary } = suite(
			cases([["TC9", "Odd step", ["open /", "wiggle the mouse", 'verify page shows "Done"'], "Done"]]),
			true,
		);
		expect(summary[0]?.mode).toBe("agent");
		expect(tests).toContain('\tawait agent.act("wiggle the mouse");');
		expect(tests).toContain("\tawait expect(screen.getByText(/Done/, { visible: true }).first()).toBeVisible();");
		expect(tests).not.toContain("agent.assert");
		expect(config).toContain("agents: { default: {} },");
		expect(config).toContain("node_modules/e2e/docs/subscriptions.mdx");
	});

	test("--agent-steps never rescues a case without a deterministic assertion", () => {
		const { summary, tests } = suite(
			cases([["TC6", "Agent only", ["open /", "wiggle the mouse"], "팝업이 표출되어야 한다."]]),
			true,
		);
		expect(summary[0]?.mode).toBe("held");
		expect(tests).not.toContain("agent.act");
	});

	test("a config without --agent-steps has no agents section and reads APP_URL", () => {
		const { config } = suite(cases([["TC1", "Valid login", LOGIN, "Welcome"]]));
		expect(config).not.toContain("agents");
		expect(config).toContain('app: { url: process.env.APP_URL ?? "http://127.0.0.1:3000" }');
		const fixed = exportE2E([], rule, { slug: "qc", baseUrl: "http://example.test" }).files[0]?.content;
		expect(fixed).toContain('app: { url: "http://example.test" }');
	});
});

describe("output", () => {
	const fixture = cases([
		["TC1", "Valid login", [...LOGIN, 'verify page shows "Welcome"'], "Welcome, admin. Dashboard loaded."],
		["TC9", "Odd step", ["open /", "wiggle the mouse"], "Done"],
	]);

	test("is byte-stable across exports", () => {
		const first = suite(fixture);
		const second = suite(fixture);
		expect(second.tests).toBe(first.tests);
		expect(second.config).toBe(first.config);
		expect(second.summary).toEqual(first.summary);
	});

	test("a TC3-like case keeps the welcome assertion that fails on a wrong password", () => {
		const { tests, summary } = suite(
			cases([
				[
					"TC3",
					"Wrong password must not pass as welcome",
					[
						"open /",
						'enter "admin" into "Username"',
						'enter "wrongpass" into "Password"',
						'click "Log in"',
						'verify page shows "Welcome"',
					],
					"Welcome, admin. Dashboard loaded.",
				],
			]),
		);
		expect(summary[0]?.mode).toBe("deterministic");
		const body = tests.slice(tests.indexOf('test("TC3'));
		expect(body).toContain('await screen.getByLabel("Password").fill("wrongpass");');
		// The expectation is kept verbatim: on the app it reads "Invalid credentials", so this must fail.
		expect(body).toContain("await expect(screen.getByText(/Welcome/, { visible: true }).first()).toBeVisible();");
		expect(body.indexOf("toBeVisible()")).toBeLessThan(body.indexOf("test.skip("));
	});

	test("slug and package.json", () => {
		expect(slugFromSource("e2e/fixtures/qc-cases.xlsx")).toBe("qc-cases");
		expect(slugFromSource("C:\\sheets\\로그인.csv")).toBe("qc");
		expect(slugFromSource("https://docs.google.com/spreadsheets/d/AbC123xyz_456789/edit#gid=0")).toBe(
			"gsheet-abc123xyz-45",
		);
		expect(JSON.parse(suitePackageJson("qc-cases"))).toEqual({
			name: "qc-cases-e2e",
			private: true,
			type: "module",
			scripts: { test: "e2e run" },
			devDependencies: { "@e2e-dev/web": "0.12.0", e2e: "0.17.0" },
		});
	});
});
