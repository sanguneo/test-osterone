/**
 * Small pure helpers for the studio run loop, extracted so they can be unit-tested
 * without importing `server.ts` (which starts the HTTP server as a side effect on import).
 */

/** Login/auth feature keywords; a sheet made entirely of these drives its own login. */
const LOGIN_RE = /로그인|login|log\s?in|sign\s?in|인증|auth/i;

/**
 * True when every case is a login/auth feature — such a sheet skips the auto-login
 * precondition so it can exercise the login flow itself (detected by category, then title).
 */
export function isLoginOnlyCases(cases: readonly { category?: string | null; title?: string | null }[]): boolean {
	return cases.length > 0 && cases.every((c) => LOGIN_RE.test(c.category ?? c.title ?? ""));
}

/**
 * Parse a heal event string (`"<kind>: <target> — <playwright error>"`) into the action
 * kind and the element it targeted, for a precise, human-readable review reason.
 */
export function parseHealEvent(healEvent: string): { kind: string; target: string } {
	const m = /^([^:]+):\s*(.*?)\s*(?:—|$)/.exec(healEvent ?? "");
	return { kind: (m?.[1] ?? "").trim(), target: (m?.[2] ?? "").trim() };
}
