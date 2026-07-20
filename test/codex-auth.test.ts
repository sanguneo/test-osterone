import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCodexLogin, readCodexModel } from "../src/model/codex-auth.ts";

function jwt(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `h.${payload}.s`;
}

function authFile(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "codex-auth-"));
	const p = join(dir, "auth.json");
	writeFileSync(p, contents);
	return p;
}

test("readCodexLogin returns access token + explicit account_id", () => {
	const p = authFile(JSON.stringify({ tokens: { access_token: jwt("acc_x"), account_id: "acc_explicit" } }));
	expect(readCodexLogin(p)).toEqual({ accessToken: jwt("acc_x"), accountId: "acc_explicit" });
	rmSync(p, { force: true });
});

test("readCodexLogin derives account id from the JWT when account_id is absent", () => {
	const p = authFile(JSON.stringify({ tokens: { access_token: jwt("acc_from_jwt") } }));
	expect(readCodexLogin(p)?.accountId).toBe("acc_from_jwt");
	rmSync(p, { force: true });
});

test("readCodexLogin returns null for a missing file", () => {
	expect(readCodexLogin(join(tmpdir(), "does-not-exist-xyz", "auth.json"))).toBeNull();
});

test("readCodexLogin returns null for malformed JSON or a token-less file", () => {
	const bad = authFile("{not json");
	expect(readCodexLogin(bad)).toBeNull();
	rmSync(bad, { force: true });
	const empty = authFile(JSON.stringify({ tokens: {} }));
	expect(readCodexLogin(empty)).toBeNull();
	rmSync(empty, { force: true });
});

test("readCodexModel reads the top-level model and ignores similar keys/sections", () => {
	const p = authFile('model_reasoning_effort = "ultra"\nmodel = "gpt-5.6-sol"\n[tui]\nmodel = "ignored"\n');
	expect(readCodexModel(p)).toBe("gpt-5.6-sol");
});

test("readCodexModel returns undefined when absent", () => {
	const p = authFile('[tui]\nmodel = "scoped"\n');
	expect(readCodexModel(p)).toBeUndefined();
});
