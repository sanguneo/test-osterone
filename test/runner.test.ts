import { expect, test } from "bun:test";
import { type FakeAction, FakePage, type Page, type PageSnapshot } from "../src/execute/page.ts";
import { determinismView, type RunEnv, runScenario } from "../src/execute/runner.ts";
import type { NormalizedTC } from "../src/intake/schema.ts";
import { MemoryAssertionCache } from "../src/interpret/assertion.ts";
import { getOrAuthorAssertions } from "../src/interpret/interpret.ts";
import { bumpRuleVersion, establishRuleFromHeaders } from "../src/interpret/rule.ts";
import { MemoryBaselineStore } from "../src/judge/baseline.ts";

const RULE = establishRuleFromHeaders(["Test ID", "Title", "Steps", "Expected Result", "Role", "Environment"]);
const ENV: RunEnv = { browser: "fake", viewport: "1280x800", baseUrl: "http://fixture" };

/** Deterministic login fixture: correct creds -> dashboard; wrong -> invalid; unknown target -> throw (heal). */
function loginReducer(action: FakeAction, state: PageSnapshot, inputs: Record<string, string>): PageSnapshot {
	if (action.kind === "goto") {
		return { url: action.target, text: `page ${action.target}`, html: `<main>page ${action.target}</main>` };
	}
	if (action.kind === "fill") return state;
	// click
	if (action.target.toLowerCase().includes("sign in")) {
		const ok = inputs.Username === "viewer" && inputs.Password === "viewer-pass";
		return ok
			? { url: "/dashboard", text: "Signed in as viewer", html: "<main>Signed in as viewer</main>" }
			: { url: "/login", text: "Invalid credentials", html: "<main>Invalid credentials</main>" };
	}
	throw new Error(`no element matches "${action.target}"`);
}

function loginTC(over: Partial<NormalizedTC> = {}): NormalizedTC {
	return {
		caseId: "TC-login",
		sourceId: "TC-01",
		title: "Viewer signs in",
		steps: [
			"Navigate to /login",
			'Enter "viewer" into "Username"',
			'Enter "viewer-pass" into "Password"',
			'Click "Sign in"',
			'Verify page shows "Signed in as viewer"',
		],
		expected: "Signed in as viewer",
		priority: null,
		role: "viewer",
		env: "staging",
		contentHash: "hash-login",
		...over,
	};
}

function run(tc: NormalizedTC) {
	const page = new FakePage({ url: "", text: "", html: "" }, loginReducer);
	return runScenario(tc, {
		page,
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
	});
}

test("pass: correct credentials satisfy the authored assertions", async () => {
	const r = await run(loginTC());
	expect(r.verdict).toBe("pass");
	expect(r.confidence).toBe(1);
	expect(r.healEvents).toEqual([]);
	expect(r.assertions.every((a) => a.passed)).toBe(true);
	expect(r.evidenceRefs.length).toBeGreaterThan(0);
});

test("fail: wrong password fails the expected-text assertion (no false pass)", async () => {
	const r = await run(
		loginTC({
			contentHash: "hash-wrong",
			steps: [
				"Navigate to /login",
				'Enter "viewer" into "Username"',
				'Enter "nope" into "Password"',
				'Click "Sign in"',
				'Verify page shows "Signed in as viewer"',
			],
		}),
	);
	expect(r.verdict).toBe("fail");
	expect(r.assertions.some((a) => !a.passed)).toBe(true);
	// confidence = confidence in the verdict; a clean all-fail is a high-confidence fail.
	expect(r.confidence).toBe(1);
});

test("needs_review: an unactionable target records a heal event and caps verdict (never silent pass)", async () => {
	const r = await run(
		loginTC({
			contentHash: "hash-heal",
			steps: ["Navigate to /login", 'Click "Nonexistent Button"', 'Verify page shows "Signed in as viewer"'],
		}),
	);
	expect(r.verdict).toBe("needs_review");
	expect(r.healEvents.length).toBeGreaterThan(0);
});

test("determinism: 5 reruns of the same case yield identical verdict/assertions/confidence", async () => {
	const views = [];
	for (let i = 0; i < 5; i++) views.push(determinismView(await run(loginTC())));
	for (const v of views) expect(v).toEqual(views[0] as (typeof views)[number]);
});

test("assertion cache: hit on rerun, miss when ruleVersion or caseHash changes (invalidation)", () => {
	const cache = new MemoryAssertionCache();
	const tc = loginTC();
	expect(getOrAuthorAssertions(tc, RULE, cache).cacheHit).toBe(false);
	expect(getOrAuthorAssertions(tc, RULE, cache).cacheHit).toBe(true);
	expect(getOrAuthorAssertions(tc, bumpRuleVersion(RULE), cache).cacheHit).toBe(false);
	expect(getOrAuthorAssertions({ ...tc, contentHash: "changed" }, RULE, cache).cacheHit).toBe(false);
});

test("plan: a provided AI plan replays its actions + assertions and ignores raw steps", async () => {
	const page = new FakePage({ url: "", text: "", html: "" }, loginReducer);
	const tc = loginTC({
		contentHash: "hash-plan",
		steps: ["(free-form prose the deterministic parser could not handle)"],
	});
	const r = await runScenario(tc, {
		page,
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
		plan: {
			actions: [
				{ kind: "goto", path: "/login" },
				{ kind: "fill", target: "Username", value: "viewer" },
				{ kind: "fill", target: "Password", value: "viewer-pass" },
				{ kind: "click", target: "Sign in" },
			],
			assertions: [{ kind: "textIncludes", value: "Signed in as viewer" }],
		},
	});
	expect(r.verdict).toBe("pass");
	expect(r.assertions).toHaveLength(1);
	expect(r.assertions[0]?.passed).toBe(true);
});

test("baseline gate: unapproved stays needs_review; approving lifts a matching re-run to pass", async () => {
	const store = new MemoryBaselineStore(() => 0);
	const tc = loginTC({ contentHash: "hash-baseline", steps: ["Navigate to /login", 'Click "Nonexistent Button"'] });
	const run2 = () =>
		runScenario(tc, {
			page: new FakePage({ url: "", text: "", html: "" }, loginReducer),
			rule: RULE,
			cache: new MemoryAssertionCache(),
			env: ENV,
			now: () => 0,
			executionId: "fixed",
			baseline: store,
			baselineEnv: "test",
		});
	const first = await run2(); // heal -> needs_review; gate proposes a pending baseline
	expect(first.verdict).toBe("needs_review");
	store.approve(tc.caseId, RULE.ruleVersion, "test");
	const second = await run2(); // approved + same masked snapshot -> pass
	expect(second.verdict).toBe("pass");
	expect(second.confidence).toBe(0.9);
});

/** Page that records trace-chunk calls, delegating page actions to a scripted FakePage. */
class TracingPage implements Page {
	readonly calls: string[] = [];
	private readonly inner = new FakePage({ url: "", text: "", html: "" }, loginReducer);
	goto(p: string) {
		return this.inner.goto(p);
	}
	click(target: string) {
		return this.inner.click(target);
	}
	fill(target: string, value: string) {
		return this.inner.fill(target, value);
	}
	snapshot() {
		return this.inner.snapshot();
	}
	async startTrace() {
		this.calls.push("start");
	}
	async stopTrace(path?: string) {
		this.calls.push(`stop:${path ?? "discard"}`);
	}
}

test("trace: a passing case starts a chunk then discards it (no trace kept)", async () => {
	const page = new TracingPage();
	const r = await runScenario(loginTC(), {
		page,
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
		tracePath: "/tmp/T.zip",
	});
	expect(r.verdict).toBe("pass");
	expect(page.calls).toEqual(["start", "stop:discard"]);
	expect(r.tracePath).toBeUndefined();
});

test("trace: a needs_review case exports the chunk to the given path (kept for review)", async () => {
	const page = new TracingPage();
	const r = await runScenario(
		loginTC({ contentHash: "hash-heal2", steps: ["Navigate to /login", 'Click "Nonexistent Button"'] }),
		{
			page,
			rule: RULE,
			cache: new MemoryAssertionCache(),
			env: ENV,
			now: () => 0,
			executionId: "fixed",
			tracePath: "/tmp/T.zip",
		},
	);
	expect(r.verdict).toBe("needs_review");
	expect(page.calls).toEqual(["start", "stop:/tmp/T.zip"]);
	expect(r.tracePath).toBe("/tmp/T.zip");
});
