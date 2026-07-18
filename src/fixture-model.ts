/**
 * Deterministic model of the reference fixture site (viewer/admin login + role-gated
 * /items). Lets the benchmark measure selection accuracy, determinism, and false-pass
 * without a live browser/docker. The SAME cases run against the real fixture via
 * BrowserPage in the live G004 integration; this model is the deterministic stand-in.
 */

import { type FakeAction, FakePage, type PageSnapshot } from "./page.ts";

function roleOf(state: PageSnapshot): string {
	return state.url.match(/#role=(\w+)/)?.[1] ?? "anon";
}

export function fixtureReducer(action: FakeAction, state: PageSnapshot, inputs: Record<string, string>): PageSnapshot {
	if (action.kind === "goto") {
		const path = action.target;
		if (path.includes("/login")) return { url: "/login#role=anon", text: "Login", html: "<main>Login</main>" };
		const role = roleOf(state);
		if (path.includes("/items")) {
			const text = role === "admin" ? "Widget A" : "Access denied";
			return { url: `/items#role=${role}`, text, html: `<main>${text}</main>` };
		}
		return { url: `${path}#role=${role}`, text: `page ${path}`, html: `<main>page ${path}</main>` };
	}
	if (action.kind === "fill") return state;
	// click
	if (action.target.toLowerCase().includes("sign in")) {
		const u = inputs.Username ?? "";
		const p = inputs.Password ?? "";
		if (u === "viewer" && p === "viewer-pass") {
			return { url: "/dashboard#role=viewer", text: "Signed in as viewer", html: "<main>Signed in as viewer</main>" };
		}
		if (u === "admin" && p === "admin-pass") {
			return { url: "/dashboard#role=admin", text: "Signed in as admin", html: "<main>Signed in as admin</main>" };
		}
		return { url: "/login#role=anon", text: "Invalid credentials", html: "<main>Invalid credentials</main>" };
	}
	throw new Error(`no element matches "${action.target}"`);
}

export function makeFixturePage(): FakePage {
	return new FakePage({ url: "", text: "", html: "" }, fixtureReducer);
}
