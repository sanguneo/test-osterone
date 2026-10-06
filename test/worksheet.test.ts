import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestCsv } from "../src/intake/ingest.ts";
import { loadSheet } from "../src/intake/load-sheet.ts";
import type { NormalizedTC } from "../src/intake/schema.ts";
import { mapColumns } from "../src/intake/table.ts";
import { parseStep } from "../src/interpret/interpret.ts";
import { establishRuleFromHeaders } from "../src/interpret/rule.ts";
import {
	REVIEW_MARKER,
	toWorksheet,
	WORKSHEET_HEADERS,
	type WorksheetRow,
	writeWorksheet,
} from "../src/interpret/worksheet.ts";
import { FakeModelClient, type ModelMessage } from "../src/model/model-client.ts";

const SPEC = "로그인 버튼 라벨은 Log in. 아이디 입력란 Username, 비밀번호 입력란 Password. 제목 Sign in.";

function nlCase(id: string, steps: string[], expected: string): NormalizedTC {
	return {
		caseId: `TC-${id}`,
		sourceId: id,
		title: `case ${id}`,
		steps,
		expected,
		priority: null,
		role: null,
		env: null,
		category: "로그인",
		contentHash: id,
	};
}

const LOGIN_NL = [
	"Open the home page",
	"Type admin into the Username field",
	"Type secret into the Password field",
	"Click the login button",
	"Confirm the page shows the welcome message",
];
const LOGIN_CANON = [
	"open /",
	'enter "admin" into "Username"',
	'enter "secret" into "Password"',
	'click "Log in"',
	'verify page shows "Welcome"',
];

type Reply = { key: string; steps: { source: number | null; step: string }[]; evidence: string };

/** A fake model that answers each batch through `answer`, recording every call. */
function fakeModel(answer: (keys: string[]) => Reply[]) {
	const calls: ModelMessage[][] = [];
	const model = new FakeModelClient((messages) => {
		calls.push(messages);
		const user = String(messages.at(-1)?.content ?? "");
		const cases = JSON.parse(user.slice(user.indexOf("CASES:\n") + 7)) as { key: string }[];
		return JSON.stringify({ cases: answer(cases.map((c) => c.key)) });
	});
	return { model, calls };
}

const canonReply = (key: string): Reply => ({
	key,
	steps: LOGIN_CANON.map((step, source) => ({ source, step })),
	evidence: "the login button -> Log in (spec)",
});

describe("toWorksheet", () => {
	test("happy path: canonical steps, original kept, expected verbatim", async () => {
		const tc = nlCase("TC1", LOGIN_NL, "Welcome, admin. Dashboard loaded.");
		const { model } = fakeModel((keys) => keys.map(canonReply));
		const { rows, warnings } = await toWorksheet({ cases: [tc], spec: SPEC, model });
		expect(warnings).toEqual([]);
		expect(rows).toHaveLength(1);
		const row = rows[0] as WorksheetRow;
		expect(row.status).toBe("ok");
		expect(row.steps).toEqual(LOGIN_CANON);
		expect(row.originalSteps).toEqual(LOGIN_NL);
		expect(row.expected).toBe("Welcome, admin. Dashboard loaded.");
		expect(row.sourceId).toBe("TC1");
		expect(row.category).toBe("로그인");
	});

	test("order must be preserved: a reordered rewrite is held for review", async () => {
		const tc = nlCase("TC1", LOGIN_NL, "Welcome, admin. Dashboard loaded.");
		const { model } = fakeModel((keys) =>
			keys.map((key) => {
				const r = canonReply(key);
				const [a, b] = [r.steps[1], r.steps[2]];
				if (a && b) r.steps.splice(1, 2, b, a);
				return r;
			}),
		);
		const { rows } = await toWorksheet({ cases: [tc], spec: SPEC, model });
		expect(rows[0]?.status).toBe("needs_review");
		expect(rows[0]?.evidence).toContain("순서");
		expect(rows[0]?.steps[0]).toBe(REVIEW_MARKER);
	});

	test("an invented extra step is held for review", async () => {
		const tc = nlCase("TC1", LOGIN_NL, "Welcome, admin. Dashboard loaded.");
		const unsourced = fakeModel((keys) =>
			keys.map((key) => {
				const r = canonReply(key);
				r.steps.splice(3, 0, { source: null, step: 'click "Remember me"' });
				return r;
			}),
		);
		const duplicated = fakeModel((keys) =>
			keys.map((key) => {
				const r = canonReply(key);
				r.steps.splice(4, 0, { source: 3, step: 'click "Log in"' });
				return r;
			}),
		);
		for (const { model } of [unsourced, duplicated]) {
			const { rows } = await toWorksheet({ cases: [tc], spec: SPEC, model });
			expect(rows[0]?.status).toBe("needs_review");
			expect(rows[0]?.evidence).toContain("지어낸");
		}
	});

	test("a check of the expected result after the last action needs no declared split", async () => {
		// Measured live: QA prose has no separate "confirm" step, so the model attaches the check of 예상결과 to
		// the click it follows. That is the case's assertion, not an invented action.
		const tc = nlCase("TC1", LOGIN_NL.slice(0, 4), "Welcome, admin. Dashboard loaded.");
		const { model } = fakeModel((keys) =>
			keys.map((key) => {
				const r = canonReply(key);
				r.steps = [...r.steps.slice(0, 4), { source: 3, step: 'verify page shows "Welcome"' }];
				return r;
			}),
		);
		const { rows } = await toWorksheet({ cases: [tc], spec: SPEC, model });
		expect(rows[0]?.status).toBe("ok");
		expect(rows[0]?.steps.at(-1)).toBe('verify page shows "Welcome"');
	});

	test("a declared split of a two-action step is accepted", async () => {
		const tc = nlCase("TC9", ["Open the home page and click the login button"], "Sign in");
		const { model } = fakeModel((keys) =>
			keys.map((key) => ({
				key,
				steps: [
					{ source: 0, step: "open /" },
					{ source: 0, step: 'click "Log in"' },
				],
				evidence: "split: original step 1 holds two actions",
			})),
		);
		const { rows } = await toWorksheet({ cases: [tc], spec: SPEC, model });
		expect(rows[0]?.status).toBe("ok");
	});

	test("unparseable steps are held for review", async () => {
		const tc = nlCase("TC1", LOGIN_NL, "Welcome, admin. Dashboard loaded.");
		const prose = fakeModel((keys) =>
			keys.map((key) => {
				const r = canonReply(key);
				r.steps[1] = { source: 1, step: "Type admin into the Username field" };
				return r;
			}),
		);
		for (const { model } of [prose]) {
			const { rows } = await toWorksheet({ cases: [tc], spec: `${SPEC} Type here`, model });
			expect(rows[0]?.status).toBe("needs_review");
		}
	});

	test("an invented verify text is held for review; a missing label written as-is stays ok", async () => {
		const tc = nlCase("TC4", ["Open the home page", "Click the Save changes button", "Confirm the heading"], "Sign in");
		const { model } = fakeModel((keys) =>
			keys.map((key) => ({
				key,
				steps: [
					{ source: 0, step: "open /" },
					{ source: 1, step: 'click "Save changes"' },
					{ source: 2, step: 'verify page shows "Dashboard"' },
				],
				evidence: "",
			})),
		);
		const { rows } = await toWorksheet({ cases: [tc], spec: SPEC, model });
		expect(rows[0]?.status).toBe("needs_review");
		expect(rows[0]?.evidence).toContain("Dashboard");
		expect(rows[0]?.evidence).not.toContain("Save changes");
	});

	test("batches of at most 10 cases per model call", async () => {
		const cases = Array.from({ length: 12 }, (_, i) => nlCase(`TC${i + 1}`, LOGIN_NL, "Welcome"));
		const { model, calls } = fakeModel((keys) => keys.map(canonReply));
		const { rows } = await toWorksheet({ cases, spec: SPEC, model });
		expect(calls).toHaveLength(2);
		expect(rows.map((r) => r.sourceId)).toEqual(cases.map((c) => c.sourceId ?? ""));
		expect(rows.every((r) => r.status === "ok")).toBe(true);
	});

	test("a failed model call holds the batch for review with the error", async () => {
		const model = new FakeModelClient(() => {
			throw new Error("quota exceeded");
		});
		const { rows, warnings } = await toWorksheet({ cases: [nlCase("TC1", LOGIN_NL, "Welcome")], model });
		expect(warnings[0]).toContain("quota exceeded");
		expect(rows[0]?.status).toBe("needs_review");
	});
});

describe("worksheet output", () => {
	test("header row maps step to 시험절차, not 원문", () => {
		const mapping = mapColumns([...WORKSHEET_HEADERS]);
		expect(mapping.step).toBe("시험절차");
		expect(mapping.id).toBe("번호");
		expect(mapping.title).toBe("시험항목");
		expect(mapping.expected).toBe("예상결과");
		expect(mapping.precondition).toBe("사전조건");
		expect(mapping.category).toBe("대분류");
		expect(Object.values(mapping)).not.toContain("원문");
	});

	test("round-trips through loadSheet + ingestCsv with steps from 시험절차", async () => {
		const ok = nlCase("TC1", LOGIN_NL, "Welcome, admin. Dashboard loaded.");
		const bad = nlCase("TC2", LOGIN_NL, "Invalid credentials. Please try again.");
		const { model } = fakeModel((keys) =>
			keys.map((key) => {
				const r = canonReply(key);
				if (key === "1") r.steps.push({ source: null, step: 'click "Extra"' });
				return r;
			}),
		);
		const { rows } = await toWorksheet({ cases: [ok, bad], spec: SPEC, model });
		const dir = mkdtempSync(join(tmpdir(), "worksheet-"));
		try {
			for (const file of ["ws.xlsx", "ws.csv"]) {
				const path = join(dir, file);
				writeWorksheet(path, rows);
				const { csv } = await loadSheet(path);
				const { all } = ingestCsv(csv);
				expect(all.map((c) => c.sourceId)).toEqual(["TC1", "TC2"]);
				expect(all[0]?.steps).toEqual(LOGIN_CANON);
				expect(all[0]?.expected).toBe("Welcome, admin. Dashboard loaded.");
				expect(all[0]?.category).toBe("로그인");
				// A held row can never execute as written: its first step is uninterpretable.
				const rule = establishRuleFromHeaders([...WORKSHEET_HEADERS]);
				expect(all[1]?.steps[0]).toBe(REVIEW_MARKER);
				expect(parseStep(all[1]?.steps[0] ?? "", rule).kind).toBe("unknown");
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
