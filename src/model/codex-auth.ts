/**
 * Detect a local ChatGPT/Codex login so the OAuth-proxy path can reuse it without
 * a pasted token. Reads `auth.json` (as written by the Codex CLI) and returns the
 * access token + account id. Pure fs read; no network. This is the convenience
 * source for `OAuthProxyModelClient` (see oauth-proxy.ts).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { getCodexAccountId } from "./oauth-proxy.ts";

export interface CodexLogin {
	accessToken: string;
	accountId?: string;
}

/** Location of the Codex CLI auth file (honors CODEX_HOME, else ~/.codex/auth.json). */
export function defaultCodexAuthPath(): string {
	return codexHomeFile("auth.json");
}

/** Location of the Codex CLI config file (honors CODEX_HOME, else ~/.codex/config.toml). */
export function defaultCodexConfigPath(): string {
	return codexHomeFile("config.toml");
}

function codexHomeFile(name: string): string {
	const home = process.env.CODEX_HOME?.trim();
	return home ? join(home, name) : join(homedir(), ".codex", name);
}

/** Read the top-level `model = "..."` from the Codex config, so the OAuth path can reuse it. */
export function readCodexModel(path = defaultCodexConfigPath()): string | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	for (const line of raw.split(/\r?\n/)) {
		const t = line.trim();
		if (t.startsWith("[")) break; // top-level `model` precedes any [table] section
		const m = /^model\s*=\s*"([^"]+)"/.exec(t);
		if (m) return m[1];
	}
	return undefined;
}

/** Read a local Codex login; returns the access token + account id, or null if absent/invalid. */
export function readCodexLogin(path = defaultCodexAuthPath()): CodexLogin | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	let parsed: { tokens?: { access_token?: unknown; account_id?: unknown } };
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	const tokens = parsed.tokens;
	const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token : "";
	if (!accessToken) return null;
	const claimId = getCodexAccountId(accessToken);
	const accountId = (typeof tokens?.account_id === "string" && tokens.account_id) || claimId || undefined;
	return { accessToken, accountId };
}
