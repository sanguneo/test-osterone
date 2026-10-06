import { describe, expect, test } from "bun:test";
import { BskPage, type BskRunner } from "../src/execute/bsk-page.ts";

type Reply = { stdout?: unknown; code?: number; stderr?: string };

/** Fake bsk: records every argv and answers from a per-command script. Never spawns anything. */
function fakeBsk(script: (args: string[]) => Reply): { run: BskRunner; calls: string[][] } {
	const calls: string[][] = [];
	const run: BskRunner = async (args) => {
		calls.push(args);
		const r = script(args);
		const stdout = typeof r.stdout === "string" ? r.stdout : JSON.stringify(r.stdout ?? {});
		return { stdout, stderr: r.stderr ?? "", code: r.code ?? 0 };
	};
	return { run, calls };
}

const started: Reply = { stdout: { session_id: "s1", browser_instance_id: "b1" } };
const stopped: Reply = { stdout: { stopped: ["s1"], failed: [] } };

function base(
	args: string[],
	evaluate: (expr: string) => Reply = () => ({ stdout: { ok: true, value: true } }),
): Reply {
	if (args[0] === "session" && args[1] === "start") return started;
	if (args[0] === "session" && args[1] === "stop") return stopped;
	if (args[0] === "evaluate") return evaluate(args[1] ?? "");
	return { stdout: { tab_id: 1 } };
}

describe("BskPage", () => {
	test("create starts a background session on the chosen browser; close stops it", async () => {
		const { run, calls } = fakeBsk((a) => base(a));
		const page = await BskPage.create({ baseUrl: "http://localhost:3000", browser: "b1", run });
		expect(page.sessionId).toBe("s1");
		await page.close();
		await page.close(); // idempotent
		expect(calls).toEqual([
			["session", "start", "--no-focus", "--json", "--browser", "b1"],
			["session", "stop", "s1", "--json"],
		]);
	});

	test("create surfaces bsk's reason when the session cannot start", async () => {
		const { run } = fakeBsk(() => ({
			code: 1,
			stdout: { code: "multiple_browsers_online", message: "more than one browser is online" },
		}));
		await expect(BskPage.create({ baseUrl: "http://x", run })).rejects.toThrow(/multiple_browsers_online/);
	});

	test("goto navigates to the URL resolved against baseUrl, then settles", async () => {
		const { run, calls } = fakeBsk((a) => base(a));
		const page = await BskPage.create({ baseUrl: "http://localhost:3000", timeoutMs: 2000, run });
		await page.goto("/login");
		await page.close();
		expect(calls[1]).toEqual([
			"navigate",
			"http://localhost:3000/login",
			"--wait-until",
			"domcontentloaded",
			"--timeout",
			"2000ms",
			"--session",
			"s1",
			"--json",
		]);
		expect(calls[2]?.[0]).toBe("evaluate");
		expect(calls[2]?.slice(2)).toEqual(["--timeout", "7000ms", "--session", "s1", "--json"]);
		expect(calls.at(-1)).toEqual(["session", "stop", "s1", "--json"]);
	});

	test("click resolves the label in the page, then clicks the tagged element with trusted input", async () => {
		const { run, calls } = fakeBsk((a) => base(a, () => ({ stdout: { ok: true, value: { found: true } } })));
		const page = await BskPage.create({ baseUrl: "http://x", timeoutMs: 1500, run });
		await page.click("Log in");
		await page.close();
		const resolver = calls[1] ?? [];
		expect(resolver[0]).toBe("evaluate");
		expect(resolver[1]).toContain('"text":"Log in"');
		expect(resolver[1]).toContain('"mode":"click"');
		expect(calls[2]).toEqual(["click", '[data-osteron-bsk="1"]', "--timeout", "1500ms", "--session", "s1", "--json"]);
		expect(calls.at(-1)).toEqual(["session", "stop", "s1", "--json"]);
	});

	test("click on a missing target throws (a heal event, never a silent success) and clicks nothing", async () => {
		const { run, calls } = fakeBsk((a) => base(a, () => ({ stdout: { ok: true, value: { found: false } } })));
		const page = await BskPage.create({ baseUrl: "http://x", run });
		await expect(page.click("Nope")).rejects.toThrow(/not found/);
		await page.close();
		expect(calls.some((c) => c[0] === "click")).toBe(false);
	});

	test("click on a target that stays disabled throws", async () => {
		const { run } = fakeBsk((a) => base(a, () => ({ stdout: { ok: true, value: { found: false, disabled: true } } })));
		const page = await BskPage.create({ baseUrl: "http://x", run });
		await expect(page.click("Log in")).rejects.toThrow(/disabled/);
		await page.close();
	});

	test("a page-side evaluate error is an error, not a result", async () => {
		const { run } = fakeBsk((a) => base(a, () => ({ stdout: { ok: false, error: { text: "Error: boom" } } })));
		const page = await BskPage.create({ baseUrl: "http://x", run });
		await expect(page.click("Log in")).rejects.toThrow(/boom/);
		await page.close();
	});

	test("session stop runs even when an action throws", async () => {
		const { run, calls } = fakeBsk((a) =>
			a[0] === "navigate" ? { code: 1, stdout: { code: "timeout", message: "navigation timed out" } } : base(a),
		);
		const page = await BskPage.create({ baseUrl: "http://x", run });
		let caught: unknown;
		try {
			await page.goto("/");
		} catch (err) {
			caught = err;
		} finally {
			await page.close();
		}
		expect(String(caught)).toContain("navigation timed out");
		expect(calls.at(-1)).toEqual(["session", "stop", "s1", "--json"]);
	});

	test("fill types into the tagged field and returns the snapshot key it landed on", async () => {
		const { run, calls } = fakeBsk((a) =>
			base(a, (expr) =>
				expr.includes('"mode":"fill"')
					? { stdout: { ok: true, value: { found: true } } }
					: expr.includes("landedAttr")
						? {
								stdout: {
									ok: true,
									value: { fields: {}, controls: {}, limits: {}, writable: [], clickables: [], landed: "Username" },
								},
							}
						: { stdout: { ok: true, value: true } },
			),
		);
		const page = await BskPage.create({ baseUrl: "http://x", timeoutMs: 2000, run });
		expect(await page.fill("Username", "admin")).toBe("Username");
		await page.close();
		expect(calls[2]).toEqual([
			"fill",
			'[data-osteron-bsk="1"]',
			"--value",
			"admin",
			"--timeout",
			"2000ms",
			"--session",
			"s1",
			"--json",
		]);
	});

	test("fill falls back to the snapshot's field names, and throws when nothing answers", async () => {
		const form = {
			fields: { 이메일: "" },
			controls: {},
			limits: {},
			writable: [{ index: 0, key: "이메일", names: ["이메일", "이메일을 입력해 주세요."] }],
			clickables: [],
		};
		const { run, calls } = fakeBsk((a) =>
			base(a, (expr) =>
				expr.includes('"mode":"fill"')
					? { stdout: { ok: true, value: { found: false } } }
					: expr.includes('"mark":true')
						? { stdout: { ok: true, value: form } }
						: { stdout: { ok: true, value: true } },
			),
		);
		const page = await BskPage.create({ baseUrl: "http://x", run });
		expect(await page.fill("이메일 입력란", "a@b.c")).toBe("이메일");
		expect(calls.find((c) => c[0] === "fill")?.slice(0, 4)).toEqual([
			"fill",
			'[data-osteron-field="0"]',
			"--value",
			"a@b.c",
		]);
		await expect(page.fill("전화번호", "010")).rejects.toThrow(/not found/);
		await page.close();
	});

	test("snapshot parses one evaluate into the PageSnapshot shape; no screenshot unless enabled", async () => {
		const value = {
			url: "http://x/",
			text: "Sign in\nLog in",
			html: "<html></html>",
			fields: { Username: "admin", Password: "" },
			controls: { "Remember me": true },
			limits: { Username: 20 },
			clickables: ["Log in"],
		};
		const { run, calls } = fakeBsk((a) => base(a, () => ({ stdout: { ok: true, value } })));
		const page = await BskPage.create({ baseUrl: "http://x", run });
		const snap = await page.snapshot();
		await page.close();
		expect(snap).toEqual({
			url: "http://x/",
			text: "Sign in\nLog in",
			html: "<html></html>",
			fields: { Username: "admin", Password: "" },
			controls: { "Remember me": true },
			fieldLimits: { Username: 20 },
			clickables: ["Log in"],
			screenshot: undefined,
		});
		expect(calls.map((c) => c[0])).toEqual(["session", "evaluate", "session"]);
	});

	test("landing reports url and document status", async () => {
		const { run } = fakeBsk((a) =>
			base(a, () => ({ stdout: { ok: true, value: { url: "http://x/login", status: 200 } } })),
		);
		const page = await BskPage.create({ baseUrl: "http://x", run });
		expect(await page.landing()).toEqual({ url: "http://x/login", status: 200 });
		await page.close();
	});

	test("does not offer resetSession (it would wipe the user's real profile)", async () => {
		const { run } = fakeBsk((a) => base(a));
		const page = await BskPage.create({ baseUrl: "http://x", run });
		expect("resetSession" in page).toBe(false);
		await page.close();
	});
});
