import { expect, test } from "bun:test";
import { type FakeAction, FakePage, type Page, type PageSnapshot } from "../src/execute/page.ts";
import {
	determinismView,
	landingProblem,
	type RunEnv,
	type RunOptions,
	runScenario,
	withoutRestatedSetup,
} from "../src/execute/runner.ts";
import type { NormalizedTC } from "../src/intake/schema.ts";
import { MemoryAssertionCache } from "../src/interpret/assertion.ts";
import { getOrAuthorAssertions, type PageAction } from "../src/interpret/interpret.ts";
import { bumpRuleVersion, establishRuleFromHeaders } from "../src/interpret/rule.ts";
import { MemoryVisionCache } from "../src/interpret/vision.ts";
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
		category: null,
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
	// The case runs to completion — it is held only because no assertion could be authored for it,
	// which is exactly what a human-approved golden baseline is for.
	const tc = loginTC({
		contentHash: "hash-baseline",
		steps: ["Navigate to /login"],
		expected: "로그인 화면이 표시되어야 한다.",
	});
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
	const first = await run2(); // no assertions -> needs_review; gate proposes a pending baseline
	expect(first.verdict).toBe("needs_review");
	expect(first.healEvents).toEqual([]);
	expect(first.executedAsWritten).toBe(true);
	store.approve(tc.caseId, RULE.ruleVersion, "test");
	const second = await run2(); // approved + same masked snapshot -> pass
	expect(second.verdict).toBe("pass");
	expect(second.confidence).toBe(0.9);
});

test("baseline gate: a case whose action failed is never lifted to pass by an approved baseline", async () => {
	// A golden baseline stands in for a missing assertion, not for running the case. The screen a
	// failed case stopped on says nothing about the behaviour the case describes.
	const store = new MemoryBaselineStore(() => 0);
	const tc = loginTC({
		contentHash: "hash-baseline-fail",
		steps: ["Navigate to /login", 'Click "Nonexistent Button"'],
	});
	const go = () =>
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
	const first = await go();
	expect(first.verdict).toBe("needs_review");
	expect(first.executedAsWritten).toBe(false);
	// Nothing was proposed, so there is nothing a reviewer could sign off in the first place.
	expect(store.get(tc.caseId, RULE.ruleVersion, "test")).toBeUndefined();
	// Even with a baseline approved out of band, the failed case stays held.
	store.propose(tc.caseId, RULE.ruleVersion, "test", "page /login");
	store.approve(tc.caseId, RULE.ruleVersion, "test");
	expect((await go()).verdict).toBe("needs_review");
});

test("baseline gate: a rule-mode case that interpreted no steps cannot be signed off green", async () => {
	// The real shape of this: a Korean prose sheet with no model connected. Every step comes back
	// `unknown`, nothing is executed, the browser sits on the landing screen — and before this rule
	// an approved baseline of that landing screen turned the whole sheet green.
	const store = new MemoryBaselineStore(() => 0);
	const home = { url: "/", text: "홈 대시보드", html: "<main>홈 대시보드</main>" };
	const tc = loginTC({
		caseId: "TC-perm",
		contentHash: "hash-perm",
		title: "권한 없는 사용자 관리 메뉴 비노출",
		steps: ["1. 일반 사용자로 접속한다", "2. 상단 내비게이션을 살펴본다"],
		expected: "관리 메뉴가 노출되지 않아야 한다.",
	});
	const go = () =>
		runScenario(tc, {
			page: new FakePage(home, loginReducer),
			rule: RULE,
			cache: new MemoryAssertionCache(),
			env: ENV,
			now: () => 0,
			executionId: "fixed",
			baseline: store,
			baselineEnv: "test",
		});
	const first = await go();
	expect(first.verdict).toBe("needs_review");
	expect(first.assertions).toHaveLength(0);
	expect(first.healEvents.every((h) => h.startsWith("skip:"))).toBe(true);
	expect(first.executedAsWritten).toBe(false);
	store.propose(tc.caseId, RULE.ruleVersion, "test", home.text);
	store.approve(tc.caseId, RULE.ruleVersion, "test");
	expect((await go()).verdict).toBe("needs_review");
});

/** Screens carry a screenshot so the vision fallback is reachable (it needs the image). */
const shotReducer = (action: FakeAction, state: PageSnapshot): PageSnapshot => ({
	url: action.kind === "goto" ? action.target : state.url,
	text: "page /login",
	html: "<main>page /login</main>",
	screenshot: "data:image/png;base64,AAA",
});
const shotPage = () =>
	new FakePage({ url: "", text: "", html: "", screenshot: "data:image/png;base64,AAA" }, shotReducer);

/** Run one case with a vision judge that always agrees the screen is fine. */
const withVision = (tc: NormalizedTC, agrees: boolean, extra: Partial<RunOptions> = {}) =>
	runScenario(tc, {
		page: shotPage(),
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
		visionAssert: async () => agrees,
		...extra,
	});

test("vision may not turn a deterministically failed assertion into a pass", async () => {
	// Measured on a live sheet: vision flipped five cases a human had marked Fail into `pass`, with
	// details like `text lacks "dxsupport@aegisep.com" · 비전 확인`. The text was genuinely absent.
	// A model's read of a screenshot is not a verdict — it routes the case to a human instead.
	const tc = loginTC({ contentHash: "h-vision-1", steps: ["Navigate to /login"], expected: "Welcome, admin" });
	const r = await withVision(tc, true);
	expect(r.verdict).toBe("needs_review");
	expect(r.assertions).toHaveLength(1);
	expect(r.assertions[0]?.passed).toBe(false); // the deterministic truth is untouched
	expect(r.assertions[0]?.detail).toContain("비전 판단");
	expect(r.visionNote).toContain("사람 확인이 필요");
	// The case did run, so the human's approved baseline is still the route to green.
	expect(r.executedAsWritten).toBe(true);
});

test("vision disagreeing about nothing leaves a plain fail alone", async () => {
	const tc = loginTC({ contentHash: "h-vision-2", steps: ["Navigate to /login"], expected: "Welcome, admin" });
	const r = await withVision(tc, false);
	expect(r.verdict).toBe("fail");
	expect(r.visionNote).toBeUndefined();
});

test("a remembered vision answer makes a rerun reproducible, even when the judge changes its mind", async () => {
	// Measured across consecutive runs of the same 98-case sheet: 5 of the 7 verdict changes were one
	// case whose failing checks were identical both times and whose vision answer had simply flipped,
	// moving it between `fail` and `needs_review`. A baseline that disagrees with itself cannot be the
	// reference every change here is accepted or rejected against.
	const visionCache = new MemoryVisionCache();
	let asked = 0;
	const flipflop = async () => {
		asked++;
		return asked === 1; // yes the first time, no ever after
	};
	const tc = loginTC({ contentHash: "h-vision-cache", steps: ["Navigate to /login"], expected: "Welcome, admin" });
	const go = () =>
		runScenario(tc, {
			page: shotPage(),
			rule: RULE,
			cache: new MemoryAssertionCache(),
			env: ENV,
			now: () => 0,
			executionId: "fixed",
			visionAssert: flipflop,
			visionCache,
			ruleId: RULE.ruleId,
			ruleVersion: RULE.ruleVersion,
		});
	const first = await go();
	const second = await go();
	expect(asked).toBe(1); // the question is put to the model once
	expect(second.verdict).toBe(first.verdict);
	expect(second.visionNote).toBe(first.visionNote);

	// A remembered answer survives a restart, because the sheet's state file carries it.
	const reloaded = new MemoryVisionCache();
	reloaded.load(visionCache.entries());
	const third = await runScenario(tc, {
		page: shotPage(),
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
		visionAssert: flipflop,
		visionCache: reloaded,
		ruleId: RULE.ruleId,
		ruleVersion: RULE.ruleVersion,
	});
	expect(asked).toBe(1);
	expect(third.verdict).toBe(first.verdict);
});

test("a rule version bump retires remembered vision answers, like it retires plans", async () => {
	const visionCache = new MemoryVisionCache();
	let asked = 0;
	const judge = async () => {
		asked++;
		return true;
	};
	const tc = loginTC({ contentHash: "h-vision-bump", steps: ["Navigate to /login"], expected: "Welcome, admin" });
	const go = (ruleVersion: number) =>
		runScenario(tc, {
			page: shotPage(),
			rule: RULE,
			cache: new MemoryAssertionCache(),
			env: ENV,
			now: () => 0,
			executionId: "fixed",
			visionAssert: judge,
			visionCache,
			ruleId: RULE.ruleId,
			ruleVersion,
		});
	await go(1);
	await go(1);
	expect(asked).toBe(1);
	await go(2);
	expect(asked).toBe(2);
});

test("without a cache the vision path behaves exactly as before", async () => {
	let asked = 0;
	const tc = loginTC({ contentHash: "h-vision-nocache", steps: ["Navigate to /login"], expected: "Welcome, admin" });
	const go = () =>
		withVision(tc, true, {
			visionAssert: async () => {
				asked++;
				return true;
			},
		});
	await go();
	await go();
	expect(asked).toBe(2);
});

test("vision may not invent a passing assertion for a case that had none", async () => {
	// Prose expectation → nothing checkable was authored. Vision used to push a synthetic
	// `textIncludes: "<the requirement sentence>"` marked passed, which read as a text assertion
	// having passed and made a purely visual case go green on a model's opinion.
	const tc = loginTC({
		contentHash: "h-vision-3",
		steps: ["Navigate to /login"],
		expected: "로고가 상단에 표출되어야 한다.",
	});
	const r = await withVision(tc, true);
	expect(r.verdict).toBe("needs_review");
	expect(r.assertions).toEqual([]); // no fabricated assertion
	expect(r.visionNote).toContain("사람 확인이 필요");
});

test("a vision-disputed case still reaches pass through a human-approved baseline", async () => {
	// Vision never decides, but the sanctioned route stays open: a human approves the screen once,
	// and later runs match it deterministically.
	const store = new MemoryBaselineStore(() => 0);
	const tc = loginTC({ contentHash: "h-vision-4", steps: ["Navigate to /login"], expected: "Welcome, admin" });
	const go = () => withVision(tc, true, { baseline: store, baselineEnv: "test" });
	expect((await go()).verdict).toBe("needs_review");
	store.approve(tc.caseId, RULE.ruleVersion, "test");
	const second = await go();
	expect(second.verdict).toBe("pass");
	expect(second.confidence).toBe(0.9);
});

test("a pass carried by an approved baseline is marked as such", async () => {
	// A green case from assertions and a green case from a year-old approval look identical in a
	// report otherwise — and "Clear runs" keeps approvals, so the approval outlives the run history
	// that would have explained it.
	const store = new MemoryBaselineStore(() => 0);
	const tc = loginTC({ contentHash: "h-lift-marked", steps: ["Navigate to /login"], expected: "Welcome, admin" });
	const go = () => withVision(tc, true, { baseline: store, baselineEnv: "test" });
	const first = await go();
	expect(first.verdict).toBe("needs_review");
	expect(first.baselineLifted).toBeUndefined();
	store.approve(tc.caseId, RULE.ruleVersion, "test");
	const second = await go();
	expect(second.verdict).toBe("pass");
	expect(second.baselineLifted).toBe(true);
	// The assertion itself still failed — the approval is what made it green, and it says so.
	expect(second.assertions[0]?.passed).toBe(false);
});

/**
 * The tautology shape observed on a live sheet: the case clicks 개인정보처리방침 and asserts that
 * 개인정보처리방침 is on the page — which is the text of the link it just clicked. The popup never
 * opens (this reducer models exactly that), and the assertion passes regardless.
 */
const inertReducer = (_action: FakeAction, state: PageSnapshot): PageSnapshot => state;
const POLICY_SCREEN: PageSnapshot = {
	url: "/login",
	text: "로그인 아이디 비밀번호 개인정보처리방침",
	html: "<main>로그인 <a>개인정보처리방침</a></main>",
};

test("a check that already held before the click cannot carry the case to pass", async () => {
	const tc = loginTC({
		caseId: "TC-policy",
		contentHash: "h-vacuous",
		steps: ["1. 개인정보처리방침 선택"],
		expected: "개인정보처리방침",
	});
	const r = await runScenario(tc, {
		page: new FakePage(POLICY_SCREEN, inertReducer),
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
	});
	// The assertion genuinely passes — the text is there. It just proves nothing about the click.
	expect(r.assertions).toHaveLength(1);
	expect(r.assertions[0]?.passed).toBe(true);
	expect(r.verdict).toBe("needs_review");
	expect(r.vacuousNote).toContain("동작 전 화면에서도");
	// The case did run, so a human can still sign the screen off as the baseline.
	expect(r.executedAsWritten).toBe(true);
});

test("a check that only holds after the click still passes", async () => {
	// Same shape, but the click actually opens the popup — the assertion now discriminates.
	const opens = (action: FakeAction, state: PageSnapshot): PageSnapshot =>
		action.kind === "click"
			? { ...state, text: `${state.text} 개인정보 처리방침 팝업 내용`, html: `${state.html}<dialog>팝업 내용</dialog>` }
			: state;
	const tc = loginTC({
		caseId: "TC-policy-ok",
		contentHash: "h-discriminates",
		steps: ["1. 개인정보처리방침 선택"],
		expected: "팝업 내용",
	});
	const r = await runScenario(tc, {
		page: new FakePage(POLICY_SCREEN, opens),
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
	});
	expect(r.verdict).toBe("pass");
	expect(r.vacuousNote).toBeUndefined();
});

test("an observation-only case may assert what was already on screen", async () => {
	// No click or fill, so there is no interaction to discriminate against — "로그인 페이지 확인" is
	// legitimately a check of what the page already renders.
	const tc = loginTC({
		caseId: "TC-observe",
		contentHash: "h-observe",
		steps: ["Navigate to /login"],
		expected: "page /login",
	});
	const r = await runScenario(tc, {
		page: new FakePage({ url: "", text: "", html: "" }, loginReducer),
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
	});
	expect(r.verdict).toBe("pass");
	expect(r.vacuousNote).toBeUndefined();
});

/**
 * A page that is still painting: the first read is missing content that the second read has. Models
 * a single-page app whose filter options render a tick after navigation.
 */
class PaintingPage implements Page {
	private reads = 0;
	private clicked = false;
	constructor(private readonly late: string) {}
	async goto(): Promise<void> {}
	async click(): Promise<void> {
		this.clicked = true;
	}
	async fill(): Promise<void> {}
	async snapshot(): Promise<PageSnapshot> {
		this.reads++;
		// Read 1 has not painted the list yet; every later read has it, click or no click.
		const text = this.reads === 1 && !this.clicked ? "기관 유형 상태 검색" : `기관 유형 ${this.late} 상태 검색`;
		return { url: "/agency", text, html: `<main>${text}</main>` };
	}
}

test("the non-discriminating check settles the screen first, so paint timing cannot decide a verdict", async () => {
	// Two live cases of identical shape once split into per-label assertions — same filter, same six
	// labels — disagreed with each other: one was held as non-discriminating, the other passed, purely
	// because one app had painted its options before the click and the other had not.
	const tc = loginTC({
		caseId: "TC-paint",
		contentHash: "h-paint",
		steps: ["1. 기관 유형 필터 선택"],
		expected: "가온",
	});
	const run = (settleMs: number) =>
		runScenario(tc, {
			page: new PaintingPage("가온"),
			rule: RULE,
			cache: new MemoryAssertionCache(),
			env: ENV,
			now: () => 0,
			executionId: "fixed",
			settleMs,
		});
	// Unsettled: the first read misses 가온, so the check believes the click revealed it → pass.
	expect((await run(0)).verdict).toBe("pass");
	// Settled: the label was already there before the click, so the check cannot attribute it → held.
	const settled = await run(1);
	expect(settled.verdict).toBe("needs_review");
	expect(settled.vacuousNote).toContain("동작 전 화면에서도");
});

/** Two screens that carry the same labels; a nav click moves between them. */
class TwoScreenPage implements Page {
	private url = "/account";
	private opened = false;
	async goto(path: string): Promise<void> {
		this.url = path;
	}
	async click(target: string): Promise<void> {
		if (target === "기관 관리") this.url = "/agency";
		else this.opened = true;
	}
	async fill(): Promise<void> {}
	async snapshot(): Promise<PageSnapshot> {
		// Both pages list the same filter labels; only opening the filter adds the option row.
		const base = `${this.url === "/agency" ? "기관 관리" : "계정 관리"} 기관유형 가온 지자체`;
		const text = this.opened ? `${base} 옵션열림` : base;
		return { url: this.url, text, html: `<main>${text}</main>` };
	}
}

test("a nav click rebases the baseline, so getting to a screen is not mistaken for exercising it", async () => {
	// The live divergence: one case was already on its page (`click 기관유형`) and passed; the identical
	// case reached the page first (`click 기관 관리` then `click 기관유형`) and was held, because the
	// baseline stayed on a different page that carried the same labels.
	const tc = loginTC({ caseId: "TC-nav", contentHash: "h-nav", steps: [], expected: "가온" });
	const r = await runScenario(tc, {
		page: new TwoScreenPage(),
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
		plan: {
			actions: [
				{ kind: "click", target: "기관 관리" },
				{ kind: "click", target: "기관유형" },
			],
			assertions: [{ kind: "textIncludes", value: "가온" }],
		},
	});
	// 가온 is on both screens, so with the baseline left on /account it looked like the filter click
	// revealed it. Rebased onto /agency, the check correctly reports it cannot attribute the label.
	expect(r.verdict).toBe("needs_review");
	expect(r.vacuousNote).toContain("동작 전 화면에서도");
});

test("a case whose last interaction navigates keeps its baseline", async () => {
	// Here the navigation *is* the expected outcome, so the pre-nav screen is the right baseline.
	const tc = loginTC({ caseId: "TC-nav-last", contentHash: "h-nav-last", steps: [], expected: "기관 관리" });
	const r = await runScenario(tc, {
		page: new TwoScreenPage(),
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
		plan: {
			actions: [{ kind: "click", target: "기관 관리" }],
			assertions: [{ kind: "urlIncludes", value: "/agency" }],
		},
	});
	expect(r.verdict).toBe("pass");
	expect(r.vacuousNote).toBeUndefined();
});

/**
 * A toast that shows once and is gone by the next read — the shape 93 of this sheet's 652 cases have
 * ("팝업/스낵바가 표출되어야 한다"). Snapshot reads are the clock: the toast is in the first read after
 * the click and in none after that.
 */
class ToastPage implements Page {
	private clicked = false;
	private readsSinceClick = 0;
	async goto(): Promise<void> {}
	async click(): Promise<void> {
		this.clicked = true;
		this.readsSinceClick = 0;
	}
	async fill(): Promise<void> {}
	async snapshot(): Promise<PageSnapshot> {
		const showToast = this.clicked && this.readsSinceClick === 0;
		if (this.clicked) this.readsSinceClick++;
		const text = showToast ? "목록 저장되었습니다" : "목록";
		return { url: "/list", text, html: `<main>${text}</main>` };
	}
}

test("a toast that appeared and vanished still satisfies a presence assertion", async () => {
	// The engine evaluated, then re-evaluated on a strictly later snapshot and threw the first result
	// away — so anything transient could only ever fail, and `assertRetryMs` only ever helped content
	// that appears *and stays*.
	const tc = loginTC({ caseId: "TC-toast", contentHash: "h-toast", steps: [], expected: "저장되었습니다" });
	const r = await runScenario(tc, {
		page: new ToastPage(),
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
		plan: {
			actions: [{ kind: "click", target: "저장" }],
			assertions: [{ kind: "textIncludes", value: "저장되었습니다" }],
		},
	});
	expect(r.verdict).toBe("pass");
	expect(r.assertions[0]?.passed).toBe(true);
	expect(r.assertions[0]?.detail).toContain("실행 중");
});

test("a case that must end with the popup gone is judged on the final screen only", async () => {
	// The mirror image, and the reason presence and absence cannot share one rule: 93 cases say
	// "종료되어야 한다". Matching "any moment observed" would pass those the instant the popup showed.
	const tc = loginTC({ caseId: "TC-closed", contentHash: "h-closed", steps: [], expected: "x" });
	const r = await runScenario(tc, {
		page: new ToastPage(),
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
		plan: {
			actions: [{ kind: "click", target: "저장" }],
			// The toast was on screen mid-run; the case asserts it is gone at the end, and it is.
			assertions: [{ kind: "textNotIncludes", value: "저장되었습니다" }],
		},
	});
	expect(r.verdict).toBe("pass");
	expect(r.assertions[0]?.passed).toBe(true);
});

/** A label that is always on the page but blinks out during a re-render. */
class FlickerPage implements Page {
	private reads = 0;
	async goto(): Promise<void> {}
	async click(): Promise<void> {}
	async fill(): Promise<void> {}
	async snapshot(): Promise<PageSnapshot> {
		this.reads++;
		// Read 2 (the post-action read) catches the page mid-re-render; every other read has the label.
		const text = this.reads === 2 ? "기관 유형 상태" : "기관 유형 가온 상태";
		return { url: "/agency", text, html: `<main>${text}</main>` };
	}
}

test("re-render flicker is not evidence that an action revealed anything", async () => {
	// The trap in reading the whole timeline: "anything varied anywhere" counts a label blinking out
	// mid-re-render as a change, and an always-visible filter label passes as if the click revealed it.
	// Only absent-at-both-ends-present-in-between is a real appearance.
	const tc = loginTC({ caseId: "TC-flicker", contentHash: "h-flicker", steps: [], expected: "가온" });
	const r = await runScenario(tc, {
		page: new FlickerPage(),
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
		plan: {
			actions: [{ kind: "click", target: "기관유형" }],
			assertions: [{ kind: "textIncludes", value: "가온" }],
		},
	});
	expect(r.verdict).toBe("needs_review");
	expect(r.vacuousNote).toContain("동작 전 화면에서도");
});

/** Records what was done, and refuses one specific target so a precondition can be made to fail. */
class PrepPage implements Page {
	readonly did: string[] = [];
	private opened = false;
	constructor(private readonly refuse?: string) {}
	async goto(path: string): Promise<void> {
		this.did.push(`goto ${path}`);
	}
	async click(target: string): Promise<void> {
		if (target === this.refuse) throw new Error(`locator.click: Timeout 1200ms exceeded — ${target}`);
		this.did.push(`click ${target}`);
		if (target === "신규 계정 생성") this.opened = true;
	}
	async fill(target: string, value: string): Promise<void> {
		this.did.push(`fill ${target}=${value}`);
	}
	async snapshot(): Promise<PageSnapshot> {
		// The 아이디 field only exists once setup opened the popup — the shape of 57 measured cases.
		const text = this.opened ? "신규 계정 생성 아이디 이메일" : "전체 계정 관리 기관 유형";
		return { url: "/account", text, html: `<main>${text}</main>`, fields: this.opened ? { 아이디: "" } : {} };
	}
}

test("preparation reaches the state the case assumes before its own steps run", async () => {
	// The measured shape: "계정 관리 페이지 내 신규 계정 생성 버튼 선택된 상태" — the field the case types
	// into does not exist until setup opened the popup. The engine never read that column, so the
	// model rediscovered it mid-run through the repair path and every recovery capped the case.
	const page = new PrepPage();
	const tc = loginTC({ caseId: "TC-prep", contentHash: "h-prep", steps: [], expected: "아이디" });
	const r = await runScenario(tc, {
		page,
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
		preparation: [
			{ kind: "goto", path: "/account" },
			{ kind: "click", target: "신규 계정 생성" },
		],
		plan: { actions: [{ kind: "fill", target: "아이디", value: "테스트" }], assertions: [] },
	});
	expect(page.did).toEqual(["goto /account", "click 신규 계정 생성", "fill 아이디=테스트"]);
	// Setup leaves no heal event, so a case whose only obstacle was the starting state is not capped.
	expect(r.healEvents).toEqual([]);
	expect(r.executedAsWritten).toBe(true);
});

test("an unreachable precondition holds the case instead of blaming the app", async () => {
	// We never got to the screen the case describes, so nothing about the case was tested — reporting
	// `fail` would file a defect against an app we never exercised.
	const page = new PrepPage("신규 계정 생성");
	const tc = loginTC({ caseId: "TC-prep2", contentHash: "h-prep2", steps: [], expected: "아이디" });
	const r = await runScenario(tc, {
		page,
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
		preparation: [{ kind: "click", target: "신규 계정 생성" }],
		plan: { actions: [{ kind: "fill", target: "아이디", value: "테스트" }], assertions: [] },
	});
	expect(r.verdict).toBe("needs_review");
	expect(r.healEvents[0]).toContain("precondition:");
	// The case's own steps are abandoned: running them against the wrong screen invents evidence.
	expect(page.did).not.toContain("fill 아이디=테스트");
	// And it can never be signed off with a baseline, because it did not run.
	expect(r.executedAsWritten).toBe(false);
});

test("setup is not mistaken for the case's own effect", async () => {
	// The discrimination check compares against the screen *after* preparation. Without that, opening
	// a popup during setup looks like the case's click revealed it, and every such case passes.
	const page = new PrepPage();
	const tc = loginTC({ caseId: "TC-prep3", contentHash: "h-prep3", steps: [], expected: "아이디" });
	const r = await runScenario(tc, {
		page,
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
		preparation: [{ kind: "click", target: "신규 계정 생성" }],
		// The case clicks something that changes nothing, and asserts text setup had already revealed.
		plan: {
			actions: [{ kind: "click", target: "아이디" }],
			assertions: [{ kind: "textIncludes", value: "아이디" }],
		},
	});
	expect(r.verdict).toBe("needs_review");
	expect(r.vacuousNote).toContain("동작 전 화면에서도");
});

/**
 * Enforces a length limit, or silently accepts everything — a limit that works vs one that does not.
 *
 * `declares` mirrors the control's own `maxlength`: an app that limits in JS declares nothing, while a
 * box with `maxlength` makes the outcome the browser's doing rather than the app's.
 */
class InputLimitPage implements Page {
	private value = "";
	constructor(
		private readonly limit: number | null,
		private readonly declares: number | null = null,
	) {}
	async goto(): Promise<void> {}
	async click(): Promise<void> {}
	async fill(_target: string, value: string): Promise<void> {
		this.value = this.limit === null ? value : [...value].slice(0, this.limit).join("");
	}
	async snapshot(): Promise<PageSnapshot> {
		return {
			url: "/account",
			text: "아이디",
			html: "<main>아이디</main>",
			fields: { 아이디: this.value },
			...(this.declares === null ? {} : { fieldLimits: { 아이디: this.declares } }),
		};
	}
}

test("a working input limit passes, even though nothing on screen changed", async () => {
	// A restriction that works changes nothing — the value is missing (or truncated) before and after —
	// so the discrimination and attribution gates would both hold it. They are exempt for field
	// assertions, because reading the field's own value is exactly the evidence they demand.
	const tc = loginTC({ caseId: "TC-lim", contentHash: "h-lim", steps: [], expected: "1. 입력 제한되어야 한다." });
	const r = await runScenario(tc, {
		page: new InputLimitPage(12),
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
		plan: {
			actions: [{ kind: "fill", target: "아이디", value: "abcdefghijklm" }],
			assertions: [{ kind: "fieldAtMost", field: "아이디", max: 12 }],
		},
	});
	expect(r.verdict).toBe("pass");
	expect(r.vacuousNote).toBeUndefined();
});

test("an input limit that does not work fails on the length the field kept", async () => {
	// The case the reverted string check got wrong: asserting the typed string is absent passes on an app
	// that truncates, so partial acceptance read as a restriction. Length is the honest question.
	const tc = loginTC({ caseId: "TC-lim2", contentHash: "h-lim2", steps: [], expected: "1. 입력 제한되어야 한다." });
	const r = await runScenario(tc, {
		page: new InputLimitPage(null),
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
		plan: {
			actions: [{ kind: "fill", target: "아이디", value: "abcdefghijklm" }],
			assertions: [{ kind: "fieldAtMost", field: "아이디", max: 12 }],
		},
	});
	expect(r.verdict).toBe("fail");
	expect(r.assertions[0]?.detail).toContain("over the 12 limit");
});

test("a field assertion whose field was never typed into fails rather than passing", async () => {
	// The soundness property: if the typed value never landed in the box the check is about, nothing was
	// restricted. A pass here is how the reverted version turned two real defects green — and the runner
	// says so in the landing's terms: the plan filled 아이디, so nothing ever landed in this field.
	const tc = loginTC({ caseId: "TC-lim3", contentHash: "h-lim3", steps: [], expected: "1. 입력 제한되어야 한다." });
	const r = await runScenario(tc, {
		page: new InputLimitPage(12),
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
		plan: {
			actions: [{ kind: "fill", target: "아이디", value: "abcdefghijklm" }],
			assertions: [{ kind: "fieldAtMost", field: "존재하지 않는 입력란", max: 12 }],
		},
	});
	expect(r.verdict).toBe("fail");
	expect(r.assertions[0]?.detail).toContain("no typed value ever landed");
});

test("a length limit the box itself declares holds for review instead of passing", async () => {
	// Measured on NO 142: the case typed 260 characters into a box that declares maxlength=255, the field
	// held 255, and the check reported a working limit — on a case whose recorded defect is that the box
	// accepts over 255. `fill` was never able to put more in, so reading the value back says nothing
	// about the app. The field exemption from the two gates exists because the value could have been
	// otherwise; here it could not, so the exemption lapses and the case goes to a human.
	const tc = loginTC({ caseId: "TC-lim4", contentHash: "h-lim4", steps: [], expected: "1. 입력 제한되어야 한다." });
	const opts = (page: Page): RunOptions => ({
		page,
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
		plan: {
			actions: [{ kind: "fill", target: "아이디", value: "abcdefghijklm" }],
			assertions: [{ kind: "fieldAtMost", field: "아이디", max: 12 }],
		},
	});
	const declared = await runScenario(tc, opts(new InputLimitPage(12, 12)));
	expect(declared.verdict).toBe("needs_review");
	// The check itself keeps its honest deterministic result — only the verdict is withheld.
	expect(declared.assertions[0]?.passed).toBe(true);
	// A limit the app enforces itself declares nothing, and still earns its pass.
	expect((await runScenario(tc, opts(new InputLimitPage(12, null)))).verdict).toBe("pass");
	// A box that declares a *longer* limit than the case asserts was free to fail, so it still counts.
	expect((await runScenario(tc, opts(new InputLimitPage(12, 40)))).verdict).toBe("pass");
});

/**
 * The NO 114 shape: the screen carries an empty box named 아이디 (a search field, another form), and the
 * fill lands somewhere else — here reported honestly as a differently-keyed element that kept the value.
 */
class WrongBoxPage implements Page {
	private typed = "";
	async goto(): Promise<void> {}
	async click(): Promise<void> {}
	async fill(_target: string, value: string): Promise<string> {
		this.typed = value;
		// The write landed, but on the element the snapshot calls "아이디#1" — not the empty "아이디".
		return "아이디#1";
	}
	async snapshot(): Promise<PageSnapshot> {
		return {
			url: "/account",
			text: "아이디",
			html: "<main>아이디</main>",
			fields: { 아이디: "", "아이디#1": this.typed },
		};
	}
}

test("a field check reads the box the fill landed in, not the first one sharing its name", async () => {
	// Measured (NO 114): the app accepts 한글ABC!@# verbatim — probed live — yet fieldExcludes passed,
	// because an empty same-named box answered for the one that was actually typed into. The landing
	// report is what tells them apart, and with it the case fails exactly as the human recorded.
	const tc = loginTC({ caseId: "TC-land", contentHash: "h-land", steps: [], expected: "1. 입력 제한되어야 한다." });
	const r = await runScenario(tc, {
		page: new WrongBoxPage(),
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
		plan: {
			actions: [{ kind: "fill", target: "아이디", value: "한글ABC!@#" }],
			assertions: [{ kind: "fieldExcludes", field: "아이디", classes: ["hangul", "upper", "symbol"] }],
		},
	});
	expect(r.verdict).toBe("fail");
	expect(r.assertions[0]?.detail).toContain("아이디#1");
});

test("a field check fails closed when no fill ever landed in that field", async () => {
	// The fill failed (heal already caps the verdict) — but the check itself must also refuse to read
	// a same-named box the case never touched. Green here is the exact false pass being closed.
	class NoLandingPage implements Page {
		async goto(): Promise<void> {}
		async click(): Promise<void> {}
		async fill(): Promise<void> {
			throw new Error("no such field");
		}
		async snapshot(): Promise<PageSnapshot> {
			return { url: "/", text: "아이디", html: "<main>아이디</main>", fields: { 아이디: "" } };
		}
	}
	const tc = loginTC({ caseId: "TC-land2", contentHash: "h-land2", steps: [], expected: "1. 입력 제한되어야 한다." });
	const r = await runScenario(tc, {
		page: new NoLandingPage(),
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
		plan: {
			actions: [{ kind: "fill", target: "아이디", value: "한글ABC!@#" }],
			assertions: [{ kind: "fieldExcludes", field: "아이디", classes: ["hangul"] }],
		},
	});
	expect(r.verdict).toBe("needs_review"); // the failed fill is a heal event
	expect(r.assertions[0]?.passed).toBe(false);
	expect(r.assertions[0]?.detail).toContain("no typed value ever landed");
});

/** The account editor's 상태 radios: clicking one selects it, and only one is ever on. */
class RadioPage implements Page {
	private selected: string;
	constructor(initial: "활성" | "비활성") {
		this.selected = initial;
	}
	async goto(): Promise<void> {}
	async click(target: string): Promise<void> {
		if (target !== "활성" && target !== "비활성") throw new Error(`no control "${target}"`);
		this.selected = target;
	}
	async fill(): Promise<void> {}
	async snapshot(): Promise<PageSnapshot> {
		// The visible text is identical either way — both labels are painted whichever one is on. That is
		// the whole reason this class of expectation needed a check that is not about text.
		return {
			url: "/account",
			text: "계정 수정 상태 활성 비활성",
			html: "<main>계정 수정</main>",
			controls: { 활성: this.selected === "활성", 비활성: this.selected === "비활성" },
		};
	}
}

test("selecting a radio the case names passes on the control's own state", async () => {
	// Measured: "1. 비활성 라디오 버튼 선택되어야 한다." had no assertion at all, because nothing about a
	// radio's state is text. Reading the control is what makes the outcome verifiable.
	const tc = loginTC({
		caseId: "TC-radio",
		contentHash: "h-radio",
		steps: ["1. 상태 항목 내 비활성 라디오 버튼 선택"],
		expected: "1. 비활성 라디오 버튼 선택되어야 한다.",
	});
	const r = await runScenario(tc, {
		page: new RadioPage("활성"),
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
		plan: {
			actions: [{ kind: "click", target: "비활성" }],
			assertions: [{ kind: "controlSelected", control: "비활성" }],
		},
	});
	expect(r.verdict).toBe("pass");
	expect(r.assertions[0]?.detail).toContain("is selected");
	// Attribution is satisfied by the control's name, which is a literal quoted from the requirement.
	expect(r.coverage).toEqual({ total: 1, covered: 1, missing: [] });
});

test("a radio that was already selected holds for review instead of passing", async () => {
	// The app opens the editor with 활성 on, so "활성 라디오 버튼 선택되어야 한다" is satisfied whether or
	// not the click ever landed. The check cannot discriminate, so a human decides — unlike the field
	// checks, this one gets no exemption, because a working selection *does* change the screen.
	const tc = loginTC({
		caseId: "TC-radio2",
		contentHash: "h-radio2",
		steps: ["1. 상태 항목 내 활성 라디오 버튼 선택"],
		expected: "1. 활성 라디오 버튼 선택되어야 한다.",
	});
	const r = await runScenario(tc, {
		page: new RadioPage("활성"),
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
		plan: {
			actions: [{ kind: "click", target: "활성" }],
			assertions: [{ kind: "controlSelected", control: "활성" }],
		},
	});
	expect(r.verdict).toBe("needs_review");
	expect(r.vacuousNote).toContain("동작 전 화면에서도");
});

test("a selection check fails when the click never reached the control", async () => {
	// The failure this pairs with: the real <input> sits at opacity 0 behind a painted label, so the
	// click can miss while everything still looks fine. A missing control is a failure to verify.
	const tc = loginTC({
		caseId: "TC-radio3",
		contentHash: "h-radio3",
		steps: ["1. 상태 항목 내 비활성 라디오 버튼 선택"],
		expected: "1. 비활성 라디오 버튼 선택되어야 한다.",
	});
	const r = await runScenario(tc, {
		page: new RadioPage("활성"),
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
		plan: {
			actions: [{ kind: "click", target: "비활성" }],
			assertions: [{ kind: "controlSelected", control: "사용 안함" }],
		},
	});
	expect(r.verdict).toBe("fail");
	expect(r.assertions[0]?.detail).toContain("not on screen");
});

test("a plan that restates the preparation does not undo it", () => {
	// Measured: the precondition clicked a row to open the account editor, then the plan's own first
	// action reloaded the same page — closing it — and the case failed on the radio it was about to click.
	const prep: PageAction[] = [
		{ kind: "goto", path: "/account" },
		{ kind: "clickRow", nth: 1 },
	];
	expect(
		withoutRestatedSetup(
			[
				{ kind: "goto", path: "/account" },
				{ kind: "click", target: "비활성" },
			],
			prep,
		),
	).toEqual([{ kind: "click", target: "비활성" }]);
	// The whole restated run goes, not just the navigation: re-opening a dialog that is already open
	// fails just as surely as reloading past it.
	expect(
		withoutRestatedSetup(
			[
				{ kind: "goto", path: "/account" },
				{ kind: "click", target: "신규 계정 생성" },
				{ kind: "click", target: "소속기관 필터" },
			],
			[
				{ kind: "goto", path: "/account" },
				{ kind: "click", target: "신규 계정 생성" },
			],
		),
	).toEqual([{ kind: "click", target: "소속기관 필터" }]);
});

test("restated-setup trimming keeps anything the plan does differently", () => {
	const prep: PageAction[] = [
		{ kind: "goto", path: "/account" },
		{ kind: "clickRow", nth: 1 },
	];
	// A different destination is the case's own business, never a restatement.
	const elsewhere: PageAction[] = [
		{ kind: "goto", path: "/agency" },
		{ kind: "click", target: "저장" },
	];
	expect(withoutRestatedSetup(elsewhere, prep)).toEqual(elsewhere);
	// No preparation at all: nothing to be redundant with.
	expect(withoutRestatedSetup(elsewhere, [])).toEqual(elsewhere);
	// A plan that is entirely the preparation keeps its actions. Running nothing would leave the verdict
	// with no before-screen to compare against, which is the one shape that can pass without acting.
	const same: PageAction[] = [
		{ kind: "goto", path: "/account" },
		{ kind: "clickRow", nth: 1 },
	];
	expect(withoutRestatedSetup(same, prep)).toEqual(same);
	// Same page, different second action → only the navigation is shared.
	expect(
		withoutRestatedSetup(
			[
				{ kind: "goto", path: "/account" },
				{ kind: "fill", target: "이메일", value: "a@b.c" },
			],
			prep,
		),
	).toEqual([{ kind: "fill", target: "이메일", value: "a@b.c" }]);
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
/**
 * Recovery ladder fixtures. `blocked` targets throw until the page is recovered (overlay
 * dismissed); `missing` targets always throw, standing in for a label that no longer exists.
 */
class LadderPage implements Page {
	readonly did: string[] = [];
	dismissals = 0;
	constructor(
		private readonly blocked: string[] = [],
		private readonly missing: string[] = [],
	) {}
	async goto(path: string): Promise<void> {
		this.did.push(`goto ${path}`);
	}
	async click(target: string): Promise<void> {
		if (this.missing.includes(target)) throw new Error(`no element matches "${target}"`);
		if (this.dismissals === 0 && this.blocked.includes(target)) throw new Error(`intercepts pointer events: ${target}`);
		this.did.push(`click ${target}`);
	}
	async fill(target: string, value: string): Promise<void> {
		this.did.push(`fill ${target}=${value}`);
	}
	async dismissOverlays(): Promise<void> {
		this.dismissals++;
	}
	async snapshot(): Promise<PageSnapshot> {
		const text = this.did.join(" · ");
		return { url: "/app", text, html: `<main>${text}</main>` };
	}
}

function runPlan(page: Page, actions: PageAction[], extra: Partial<RunOptions> = {}) {
	return runScenario(loginTC({ contentHash: "hash-ladder", steps: ["(plan-driven)"], expected: "" }), {
		page,
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
		recoveryDelayMs: 0,
		plan: { actions, assertions: [{ kind: "textIncludes", value: "click 확인" }] },
		...extra,
	});
}

test("recovery: an overlay-blocked action is retried after dismissOverlays and leaves no heal event", async () => {
	const page = new LadderPage(["저장"]);
	const r = await runPlan(page, [
		{ kind: "click", target: "저장" },
		{ kind: "click", target: "확인" },
	]);
	expect(page.dismissals).toBe(1);
	expect(page.did).toEqual(["click 저장", "click 확인"]);
	expect(r.healEvents).toEqual([]);
	expect(r.verdict).toBe("pass");
	expect(r.aborted).toBeUndefined();
});

test("abort: an unrecoverable action stops the case instead of running the rest on a wrong screen", async () => {
	const page = new LadderPage([], ["없는버튼"]);
	const r = await runPlan(page, [
		{ kind: "click", target: "열기" },
		{ kind: "click", target: "없는버튼" },
		{ kind: "click", target: "삭제" },
		{ kind: "click", target: "확인" },
	]);
	// the destructive tail never ran
	expect(page.did).toEqual(["click 열기"]);
	expect(r.aborted).toBe(true);
	expect(r.healEvents[0]).toContain('click: 없는버튼 — no element matches "없는버튼"');
	expect(r.healEvents[1]).toContain("abort: 남은 동작 2개");
	expect(r.verdict).toBe("needs_review");
});

test("AI repair: a failed action is re-grounded on the live screen, recorded, and never silently passed", async () => {
	const page = new LadderPage([], ["저장"]);
	const seen: string[] = [];
	const r = await runPlan(
		page,
		[
			{ kind: "click", target: "저장" },
			{ kind: "click", target: "확인" },
		],
		{
			repair: async (req) => {
				seen.push(`${req.action.kind}:${req.error.slice(0, 20)}`);
				return { kind: "click", target: "저장하기" };
			},
		},
	);
	expect(seen).toHaveLength(1);
	expect(page.did).toEqual(["click 저장하기", "click 확인"]); // repaired, then the plan continued
	expect(r.healEvents[0]).toContain("repair: 저장 — AI가 화면을 다시 읽고 '저장하기'(click)로 교정해 진행했습니다");
	expect(r.aborted).toBeUndefined();
	// assertions all pass, but AI intervention still caps the verdict — a human confirms it once
	expect(r.assertions.every((a) => a.passed)).toBe(true);
	expect(r.verdict).toBe("needs_review");
});

test("AI repair is budgeted, and a declined repair still aborts the case", async () => {
	const page = new LadderPage([], ["A", "B"]);
	let calls = 0;
	const r = await runPlan(
		page,
		[
			{ kind: "click", target: "A" },
			{ kind: "click", target: "B" },
		],
		{
			repairBudget: 1,
			repair: async () => {
				calls++;
				return null; // the model declines rather than guessing
			},
		},
	);
	expect(calls).toBe(1);
	expect(r.aborted).toBe(true);
	expect(page.did).toEqual([]);
});

/** Page that renders a real button list, so the runner can tell "missing" from "blocked". */
class ScannablePage implements Page {
	readonly tried: string[] = [];
	dismissals = 0;
	constructor(private readonly present: string[]) {}
	async goto(): Promise<void> {}
	async click(target: string): Promise<void> {
		this.tried.push(target);
		if (!this.present.includes(target)) throw new Error(`no element matches "${target}"`);
	}
	async fill(): Promise<void> {}
	async dismissOverlays(): Promise<void> {
		this.dismissals++;
	}
	async snapshot(): Promise<PageSnapshot> {
		const html = this.present.map((b) => `<button>${b}</button>`).join("");
		return { url: "/app", text: this.present.join(" "), html: `<main>${html}</main>` };
	}
}

test("a target that is absent from the live DOM skips the patient retry (and a blocked one keeps it)", async () => {
	// Missing: one attempt, then straight to the ladder's next rung — no second locator timeout.
	const missing = new ScannablePage(["저장", "취소"]);
	const r1 = await runPlan(missing, [{ kind: "click", target: "결재요청" }]);
	expect(missing.tried).toEqual(["결재요청"]);
	expect(missing.dismissals).toBe(0);
	expect(r1.aborted).toBe(true);

	// Present but failing (overlay intercept): still worth clearing the overlay and waiting properly.
	const blocked = new ScannablePage([]);
	const r2 = await runPlan(blocked, [{ kind: "click", target: "저장" }]);
	expect(blocked.tried).toEqual(["저장", "저장"]);
	expect(blocked.dismissals).toBe(1);
	expect(r2.aborted).toBe(true);
});

test("unknown step: an uninterpretable step is recorded (never silently skipped) and the rest still runs", async () => {
	const page = new FakePage({ url: "", text: "", html: "" }, loginReducer);
	const r = await runScenario(
		loginTC({
			contentHash: "hash-unknown",
			steps: ["Navigate to /login", "Frobnicate the widget until it hums", 'Verify page shows "page /login"'],
			expected: "page /login",
		}),
		{ page, rule: RULE, cache: new MemoryAssertionCache(), env: ENV, now: () => 0, executionId: "fixed" },
	);
	expect(r.healEvents).toHaveLength(1);
	expect(r.healEvents[0]).toContain("skip: Frobnicate the widget until it hums");
	expect(r.assertions.every((a) => a.passed)).toBe(true); // the goto still happened
	expect(r.verdict).toBe("needs_review"); // …but the case did not run in full
	expect(r.aborted).toBeUndefined();
});

/** Page whose navigations can redirect or 404, so landing verification can be exercised. */
class RoutedPage implements Page {
	url = "/";
	status: number | null = 200;
	readonly did: string[] = [];
	constructor(
		private readonly redirects: Record<string, string> = {},
		private readonly statuses: Record<string, number> = {},
	) {}
	async goto(path: string): Promise<void> {
		this.did.push(`goto ${path}`);
		this.url = this.redirects[path] ?? path;
		this.status = this.statuses[path] ?? 200;
	}
	async click(target: string): Promise<void> {
		this.did.push(`click ${target}`);
	}
	async fill(target: string, value: string): Promise<void> {
		this.did.push(`fill ${target}=${value}`);
	}
	async landing(): Promise<{ url: string; status: number | null }> {
		return { url: this.url, status: this.status };
	}
	async snapshot(): Promise<PageSnapshot> {
		const text = this.did.join(" · ");
		return { url: this.url, text, html: `<main>${text}</main>` };
	}
}

test("landingProblem flags auth bounces and error statuses, and tolerates benign redirects", () => {
	expect(
		landingProblem("/approvals", { url: "https://app.test/auth/login?returnUrl=/approvals", status: 200 }),
	).toContain("로그인 화면");
	expect(landingProblem("/approvals", { url: "https://app.test/approvals", status: 404 })).toContain("HTTP 404");
	// benign: sub-route, trailing slash, query — and a root goto may redirect anywhere by design
	expect(landingProblem("/orders", { url: "https://app.test/orders/list", status: 200 })).toBeNull();
	expect(landingProblem("/orders", { url: "https://app.test/orders/?tab=1", status: 200 })).toBeNull();
	expect(landingProblem("/", { url: "https://app.test/auth/login", status: 200 })).toBeNull();
	// a redirect that is not an auth bounce is not our business to judge
	expect(landingProblem("/dashboard", { url: "https://app.test/home", status: 200 })).toBeNull();
	// asking for the login page and landing there is correct
	expect(landingProblem("/auth/login", { url: "https://app.test/auth/login", status: 200 })).toBeNull();
	expect(landingProblem("/x", null)).toBeNull();
});

test("route check: a goto bounced to the login screen fails the step instead of testing the wrong page", async () => {
	const page = new RoutedPage({ "/approvals": "https://app.test/auth/login?returnUrl=/approvals" });
	const r = await runPlan(page, [
		{ kind: "goto", path: "/approvals" },
		{ kind: "click", target: "확인" },
	]);
	// the goto is retried once by the ladder, but the click on the wrong screen never runs
	expect(page.did.filter((d) => d.startsWith("click"))).toEqual([]);
	expect(r.aborted).toBe(true);
	expect(r.healEvents[0]).toContain("goto: /approvals — 요청 경로 /approvals 대신 로그인 화면");
	expect(r.verdict).toBe("needs_review");
});

test("route check: a 404 route is reported, while a benign sub-route redirect runs clean", async () => {
	const missing = new RoutedPage({}, { "/nope": 404 });
	const r1 = await runPlan(missing, [{ kind: "goto", path: "/nope" }]);
	expect(r1.healEvents[0]).toContain("HTTP 404");
	expect(r1.aborted).toBe(true);

	const redirected = new RoutedPage({ "/orders": "https://app.test/orders/list" });
	const r2 = await runPlan(redirected, [
		{ kind: "goto", path: "/orders" },
		{ kind: "click", target: "확인" },
	]);
	expect(r2.healEvents).toEqual([]);
	expect(r2.verdict).toBe("pass");
});

test("a glyph never becomes a check, so a case is never failed on iconography", async () => {
	// Measured (NO 161): "<<, <, 페이지번호, >, >> 버튼이 제공되어야 한다" — the app paints those buttons as
	// icon elements with no text, the human passed the screen, and the engine failed it on four
	// pure-glyph quotes. Such a check cannot pass on a working app, so it is not authored at all and
	// the clause is simply unchecked — which the coverage gate reports honestly.
	const r = await run(
		loginTC({
			contentHash: "hash-glyph-only",
			steps: ["Navigate to /login", 'Verify page shows "<<"', 'Verify page shows "page /login"'],
			expected: "page /login",
		}),
	);
	expect(r.assertions.map((a) => a.assertion)).toEqual([{ kind: "textIncludes", value: "page /login" }]);
	expect(r.verdict).not.toBe("fail");

	// A real word alongside it still decides the verdict on its own evidence.
	const mixed = await run(
		loginTC({
			contentHash: "hash-glyph-mixed",
			steps: ["Navigate to /login", 'Verify page shows "<<"', 'Verify page shows "Signed in as viewer"'],
			expected: "Signed in as viewer",
		}),
	);
	expect(mixed.assertions.every((a) => a.assertion.kind !== "textIncludes" || a.assertion.value !== "<<")).toBe(true);
	expect(mixed.verdict).toBe("fail");
});

/** A duplicate-check control: it answers only about what the box beside it holds. */
class DuplicateCheckPage implements Page {
	private name = "";
	private checked = false;
	async goto(): Promise<void> {}
	async click(target: string): Promise<void> {
		if (target === "기관명 중복확인") this.checked = true;
	}
	async fill(target: string, value: string): Promise<string> {
		this.name = value;
		return target;
	}
	async snapshot(): Promise<PageSnapshot> {
		// The app confirms a name only when there is one to confirm — probed live on the real screen.
		const text = this.checked && this.name ? "기관 생성 기관명 사용할 수 있는 기관명입니다." : "기관 생성 기관명";
		return { url: "/agency", text, html: `<main>${text}</main>`, fields: { 기관명: this.name } };
	}
}

const runDuplicateCheck = (prep: PageAction[], caseId: string) =>
	runScenario(loginTC({ caseId, contentHash: caseId, steps: [], expected: "사용할 수 있는 기관명입니다." }), {
		page: new DuplicateCheckPage(),
		rule: RULE,
		cache: new MemoryAssertionCache(),
		env: ENV,
		now: () => 0,
		executionId: "fixed",
		preparation: prep,
		plan: {
			actions: [{ kind: "click", target: "기관명 중복확인" }],
			assertions: [{ kind: "textIncludes", value: "사용할 수 있는 기관명입니다." }],
		},
	});

test("pressing a field's own control while the field is empty holds as an unmet precondition", async () => {
	// Measured (NO 206): the precondition is a data state — "중복된 이름이 없는 경우" — which the authored
	// setup turned into "open the dialog" and nothing more. Failing here files a defect against an app
	// that behaved correctly: with a name typed, the confirmation appears exactly as the sheet says.
	const r = await runDuplicateCheck([{ kind: "goto", path: "/agency" }], "TC-dupe-empty");
	expect(r.verdict).toBe("needs_review");
	expect(r.healEvents.join()).toContain("precondition: fill: 기관명");
	// The case did not run as written, so no approved baseline may sign it off either.
	expect(r.executedAsWritten).toBe(false);
});

test("the same case passes once the setup actually enters a value", async () => {
	const r = await runDuplicateCheck(
		[
			{ kind: "goto", path: "/agency" },
			{ kind: "fill", target: "기관명", value: "가온" },
		],
		"TC-dupe-filled",
	);
	expect(r.verdict).toBe("pass");
	expect(r.healEvents).toEqual([]);
});

/** A control that only paints after a few reads — the SPA shape the absence check kept racing. */
class LatePaintPage implements Page {
	readonly tried: string[] = [];
	private reads = 0;
	constructor(private readonly paintsAfter: number) {}
	async goto(): Promise<void> {}
	async click(target: string): Promise<void> {
		this.tried.push(target);
		if (this.reads < this.paintsAfter) throw new Error(`locator.click: Timeout exceeded — ${target}`);
	}
	async fill(): Promise<void> {}
	async snapshot(): Promise<PageSnapshot> {
		this.reads++;
		const painted = this.reads >= this.paintsAfter;
		// Rendered either way — an empty shell is deliberately read as "not painted yet, stay patient",
		// and the race being fixed here is about a painted screen that does not carry the control *yet*.
		const html = painted
			? "<main><h1>목록</h1><button>검색</button><button>저장</button></main>"
			: "<main><h1>목록</h1><button>검색</button></main>";
		return { url: "/app", text: painted ? "목록 검색 저장" : "목록 검색", html };
	}
}

test("an absence is confirmed on a settled screen, so paint timing cannot choose the recovery path", async () => {
	// One read after the quick attempt decided the whole ladder: present meant "wait properly", absent
	// meant "give up now". Measured across consecutive runs, a case alternated between the two and one
	// flip moved its verdict from pass to needs_review. Polling the cheap DOM read removes the race — a
	// few ms against the 4s locator budget the decision is protecting.
	const patient = new LatePaintPage(3);
	const r = await runPlan(patient, [{ kind: "click", target: "저장" }], { settleMs: 1 });
	expect(patient.tried.length).toBeGreaterThan(1); // the settle saw it paint, so the patient rung ran
	expect(r.healEvents).toEqual([]);

	// A target that never paints still fails fast: the poll is bounded, so a genuinely absent control
	// does not buy a second full locator timeout — which is the reason the fast path exists.
	const absent = new LatePaintPage(99);
	const r2 = await runPlan(absent, [{ kind: "click", target: "저장" }], { settleMs: 1 });
	expect(absent.tried).toEqual(["저장"]);
	expect(r2.aborted).toBe(true);
});

test("with settleMs off the ladder is what it always was", async () => {
	// FakePage-driven unit runs pass no settle, and they must not start paying for a poll.
	const absent = new LatePaintPage(99);
	const r = await runPlan(absent, [{ kind: "click", target: "저장" }]);
	expect(absent.tried).toEqual(["저장"]);
	expect(r.aborted).toBe(true);
});
