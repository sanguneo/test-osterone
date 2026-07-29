import { expect, test } from "bun:test";

import {
	type AuthStep,
	authStepFor,
	endsSignedOut,
	parseHealEvent,
	restoreTerminal,
	runModelMeta,
	stalePlaywrightTempDirs,
	startsSignedOut,
	summarizeHeal,
	TERMINAL_RESTORE_SEQ,
	TRACE_KEEP_LIMIT,
	tracesToEvict,
} from "../src/app/studio/run-helpers.ts";

const ADMIN = { id: "a1", username: "admin", password: "pw" };
const VIEWER = { id: "a2", username: "viewer", password: "pw" };

/**
 * Walk a sheet the way the run loop does, so the *sequence* of session decisions is pinned —
 * this is the part that silently rots (a login case inheriting a session, a role case running
 * as the wrong user) because each individual decision looks fine in isolation.
 */
function walk(
	sheet: { tc: { category?: string | null; title?: string | null }; account?: typeof ADMIN }[],
	opts: Parameters<typeof authStepFor>[3] = {},
): string[] {
	const state = { signedInAs: null as string | null, failedSignIns: 0 };
	const trace: string[] = [];
	for (const { tc, account } of sheet) {
		const step: AuthStep = authStepFor(tc, account, state, opts);
		trace.push(step.kind === "signIn" ? `signIn:${step.accountId}` : step.kind);
		if (step.kind === "signOut") state.signedInAs = null;
		if (step.kind === "signIn") state.signedInAs = step.accountId;
		if (endsSignedOut(tc)) state.signedInAs = null;
	}
	return trace;
}

test("no eager login: a sheet that starts with auth cases never signs in before verifying them", () => {
	// Verifying the login page must not be preceded by a login — the first sign-in happens only
	// when a case actually needs a session, which is the third case here.
	expect(
		walk([
			{ tc: { category: "로그인", title: "정상 로그인" }, account: ADMIN },
			{ tc: { category: "로그인", title: "비밀번호 오류 안내" }, account: ADMIN },
			{ tc: { category: "전자결재", title: "목록 조회" }, account: ADMIN },
		]),
	).toEqual(["signOut", "signOut", "signIn:a1"]);
});

test("startsSignedOut: an auth-feature case must meet a real login form, so it starts signed out", () => {
	expect(startsSignedOut({ category: "로그인", title: "대시보드 진입" })).toBe(true);
	expect(startsSignedOut({ category: null, title: "Sign in with a valid account" })).toBe(true);
	// The spreadsheet tab is often the file's name, not the feature — the title still classifies it.
	expect(startsSignedOut({ category: "TestCase_공문발송 시스템_관리자", title: "로그인" })).toBe(true);
	expect(startsSignedOut({ category: "   ", title: "로그인 실패 3회 시 안내" })).toBe(true);
	// Password/ID recovery is reachable only while signed out — same contract.
	expect(startsSignedOut({ category: "TestCase_관리자", title: "아이디/비밀번호 찾기" })).toBe(true);
	expect(startsSignedOut({ category: null, title: "Forgot password flow" })).toBe(true);
	// …without dragging in near-misses: 인증서 is a certificate, "authoring" is not auth.
	expect(startsSignedOut({ category: "전자결재", title: "인증서 등록" })).toBe(false);
	expect(startsSignedOut({ category: null, title: "Plan authoring workflow" })).toBe(false);
	expect(startsSignedOut({ category: null, title: "결재 문서 상신" })).toBe(false);
	expect(startsSignedOut({})).toBe(false);
});

test("endsSignedOut: a logout case kills the session, and is not confused with a login case", () => {
	expect(endsSignedOut({ category: "로그아웃" })).toBe(true);
	expect(endsSignedOut({ category: null, title: "Sign out from the header menu" })).toBe(true);
	expect(endsSignedOut({ category: "로그인" })).toBe(false);
	// the two classifications are independent: a logout case must START signed in
	expect(startsSignedOut({ category: "로그아웃" })).toBe(false);
});

test("session contract: login cases start signed out, role cases switch users, logout forces a re-login", () => {
	const sheet = [
		{ tc: { category: "로그인", title: "정상 로그인" }, account: ADMIN },
		{ tc: { category: "로그인", title: "잘못된 비밀번호" }, account: ADMIN },
		{ tc: { category: "전자결재", title: "관리자가 문서를 상신한다" }, account: ADMIN },
		{ tc: { category: "전자결재", title: "뷰어가 목록을 본다" }, account: VIEWER },
		{ tc: { category: "전자결재", title: "뷰어가 상세를 본다" }, account: VIEWER },
		{ tc: { category: "로그아웃", title: "헤더에서 로그아웃" }, account: VIEWER },
		{ tc: { category: "전자결재", title: "로그아웃 후 목록 재확인" }, account: VIEWER },
	];
	expect(walk(sheet)).toEqual([
		"signOut", // a login case must meet a real form…
		"signOut", // …every time, not just the first
		"signIn:a1", // the login case left us signed out — sign in as the case's role account
		"signIn:a2", // role changed viewer→ switch users (not just hand the plan other credentials)
		"none", // already the right user: no wasted login
		"none", // the logout case must START signed in
		"signIn:a2", // …and it ended the session, so restore it
	]);
});

test("session contract: sample runs are untouched, and a dead app stops costing a login per case", () => {
	// Sample runs never touch the session.
	expect(walk([{ tc: { category: "로그인" }, account: ADMIN }], { sample: true })).toEqual(["none"]);

	// After the failure budget, the planner stops asking (no login timeout per remaining case).
	const exhausted = { signedInAs: null, failedSignIns: 2 };
	expect(authStepFor({ category: "전자결재" }, ADMIN, exhausted)).toEqual({ kind: "none" });
	expect(authStepFor({ category: "전자결재" }, ADMIN, { signedInAs: null, failedSignIns: 1 })).toEqual({
		kind: "signIn",
		accountId: "a1",
	});
	// An account with no credentials cannot be signed in as.
	expect(authStepFor({ category: "전자결재" }, { id: "a3" }, { signedInAs: null, failedSignIns: 0 })).toEqual({
		kind: "none",
	});
});

test("parseHealEvent: splits '<kind>: <target> — <error>' into kind + target", () => {
	expect(parseHealEvent("click: 로그인 — locator.click: Timeout 4000ms exceeded.")).toEqual({
		kind: "click",
		target: "로그인",
	});
	expect(parseHealEvent("fill: Username — boom")).toEqual({ kind: "fill", target: "Username" });
	expect(parseHealEvent("goto: /login")).toEqual({ kind: "goto", target: "/login" });
	expect(parseHealEvent("")).toEqual({ kind: "", target: "" });
});

test("tracesToEvict keeps the newest traces and drops the rest (a sweep must not fill the disk)", () => {
	const files = Array.from({ length: 5 }, (_, i) => ({ path: `t${i}.zip`, mtimeMs: i * 1000 }));
	// Under the cap nothing is evicted.
	expect(tracesToEvict(files, 5)).toEqual([]);
	expect(tracesToEvict([], 2)).toEqual([]);
	// Over it, the oldest go first and the newest survive.
	expect(tracesToEvict(files, 2)).toEqual(["t2.zip", "t1.zip", "t0.zip"]);
	expect(tracesToEvict(files, 0)).toHaveLength(5);
	expect(TRACE_KEEP_LIMIT).toBeGreaterThan(0);
});

test("stalePlaywrightTempDirs reaps dead trace scratch, never a live one or a browser profile", () => {
	const now = Date.parse("2026-07-27T12:00:00Z");
	const hoursAgo = (h: number) => now - h * 3600_000;
	const entries = [
		{ name: "playwright-artifacts-02PnNp", mtimeMs: hoursAgo(6) }, // the 13GB orphan
		{ name: "playwright-tracing-1NM6ti", mtimeMs: hoursAgo(6) },
		{ name: "playwright-artifacts-live", mtimeMs: hoursAgo(0.1) }, // a run happening right now
		{ name: "playwright_chromiumdev_profile-7I183v", mtimeMs: hoursAgo(9) }, // tiny, may be live
		{ name: "npm-cache-x", mtimeMs: hoursAgo(99) }, // not ours
	];
	expect(stalePlaywrightTempDirs(entries, now)).toEqual(["playwright-artifacts-02PnNp", "playwright-tracing-1NM6ti"]);
	expect(stalePlaywrightTempDirs(entries, now, 24 * 3600_000)).toEqual([]);
});

test("summarizeHeal: a failed action outranks an AI repair, which outranks an uninterpreted step", () => {
	// The repair came first chronologically, but the later hard failure is what needs review.
	expect(
		summarizeHeal([
			"repair: 저장 — AI가 '저장하기'로 교정했습니다",
			"click: 결재 요청 — no element",
			"abort: 남은 동작 2개 — 중단",
		]),
	).toEqual({ reason: "self-heal: click", target: "결재 요청" });

	expect(summarizeHeal(["skip: 프로시저 실행 — 해석 실패", "repair: 저장 — 교정함"])).toEqual({
		reason: "ai repair",
		target: "저장",
	});
	expect(summarizeHeal(["skip: 프로시저 실행 — 해석 실패"])).toEqual({
		reason: "step not interpreted",
		target: "프로시저 실행",
	});
	// an unparseable note still produces a usable reason rather than an empty panel
	expect(summarizeHeal(["weird note"])).toEqual({ reason: "self-heal: action", target: "" });
	expect(summarizeHeal([])).toEqual({ reason: "self-heal: action", target: "" });
});

test("runModelMeta stamps an AI run with the model and reasoning level that produced it", () => {
	expect(runModelMeta("ai", { model: "gpt-5.6-sol", reasoning: "xhigh" })).toEqual({
		model: "gpt-5.6-sol",
		reasoning: "xhigh",
	});
	// Reasoning is optional: the connection can leave the model's own default in place.
	expect(runModelMeta("ai", { model: "gpt-5.6-sol" })).toEqual({ model: "gpt-5.6-sol" });
	expect(runModelMeta("ai", { model: " gpt-5.6-sol ", reasoning: "  " })).toEqual({ model: "gpt-5.6-sol" });
});

test("runModelMeta attributes no model to a rule-interpreted run", () => {
	// A rule run involves no model at all. Stamping the connected one would make it look like a
	// model result and silently corrupt any later model-vs-model comparison of the same sheet.
	expect(runModelMeta("rule", { model: "gpt-5.6-sol", reasoning: "high" })).toEqual({});
	expect(runModelMeta("ai", null)).toEqual({});
	expect(runModelMeta("ai", undefined)).toEqual({});
});
/** Records what `restoreTerminal` did to a fake terminal. */
function fakeIo(over: { stdinTty?: boolean; stdoutTty?: boolean; stderrTty?: boolean } = {}) {
	const writes: { fd: number; text: string }[] = [];
	const rawModes: boolean[] = [];
	return {
		writes,
		rawModes,
		io: {
			stdin: { isTTY: over.stdinTty ?? true, setRawMode: (m: boolean) => void rawModes.push(m) },
			stdout: { isTTY: over.stdoutTty ?? true },
			stderr: { isTTY: over.stderrTty ?? true },
			writeSync: (fd: number, text: string) => void writes.push({ fd, text }),
		},
	};
}

test("restoreTerminal drops raw mode and shows the cursor again on the console", () => {
	const { io, writes, rawModes } = fakeIo();
	restoreTerminal(io);
	// setRawMode(false) is what resets ENABLE_ECHO_INPUT on a Windows console a child left echo-off.
	expect(rawModes).toEqual([false]);
	expect(writes).toEqual([{ fd: 1, text: TERMINAL_RESTORE_SEQ }]);
	expect(TERMINAL_RESTORE_SEQ).toContain("\u001b[?25h"); // show cursor
});

test("restoreTerminal writes to stderr when only stderr is the console, and to neither when piped", () => {
	// `studio > run.log` still has a live console on stderr — the cursor lives there, not in the file.
	const onlyErr = fakeIo({ stdoutTty: false });
	restoreTerminal(onlyErr.io);
	expect(onlyErr.writes).toEqual([{ fd: 2, text: TERMINAL_RESTORE_SEQ }]);

	// Fully redirected: writing escape codes into a log file would just corrupt it.
	const piped = fakeIo({ stdinTty: false, stdoutTty: false, stderrTty: false });
	restoreTerminal(piped.io);
	expect(piped.writes).toEqual([]);
	expect(piped.rawModes).toEqual([]);
});

test("restoreTerminal never throws on a half-closed terminal", () => {
	// It runs from the `exit` handler, where a handle can already be gone. Throwing here would turn
	// a clean shutdown into a crash — and leave the terminal broken, which is the whole point.
	const boom = () => {
		throw new Error("EBADF");
	};
	expect(() =>
		restoreTerminal({
			stdin: { isTTY: true, setRawMode: boom },
			stdout: { isTTY: true },
			stderr: { isTTY: true },
			writeSync: boom,
		}),
	).not.toThrow();
	// A stdin without setRawMode (a piped-in stream typed as a TTY) is skipped, not called blindly.
	expect(() =>
		restoreTerminal({ stdin: { isTTY: true }, stdout: { isTTY: false }, stderr: { isTTY: false }, writeSync: boom }),
	).not.toThrow();
});
