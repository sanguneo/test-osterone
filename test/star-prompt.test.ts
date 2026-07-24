import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	maybePromptStar,
	REPO_URL,
	STAR_OPT_OUT_ENV,
	starAlreadyShown,
	starOptedOut,
	starPromptLines,
} from "../src/star-prompt.ts";

const tmpDirs: string[] = [];
function stateFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "to-star-"));
	tmpDirs.push(dir);
	return join(dir, "state.json");
}
function capture(isTTY = true) {
	const out: string[] = [];
	return { out, stream: { isTTY, write: (s: string) => out.push(s) } };
}

afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("starPromptLines includes the repo URL and opt-out hint", () => {
	const text = starPromptLines().join("\n");
	expect(text).toContain(REPO_URL);
	expect(text).toContain(STAR_OPT_OUT_ENV);
});

test("starOptedOut honors CI, DO_NOT_TRACK, and the project flag", () => {
	expect(starOptedOut({})).toBe(false);
	expect(starOptedOut({ CI: "true" })).toBe(true);
	expect(starOptedOut({ DO_NOT_TRACK: "1" })).toBe(true);
	expect(starOptedOut({ [STAR_OPT_OUT_ENV]: "1" })).toBe(true);
});

test("maybePromptStar prints once, then stays silent and records the flag", () => {
	const file = stateFile();
	const { out, stream } = capture();

	const first = maybePromptStar({ stream, stateFile: file, env: {} });
	expect(first).toBe(true);
	expect(out.join("")).toContain(REPO_URL);
	expect(existsSync(file)).toBe(true);
	expect(starAlreadyShown(file)).toBe(true);

	const second = maybePromptStar({ stream, stateFile: file, env: {} });
	expect(second).toBe(false);
});

test("maybePromptStar is silent when opted out or non-interactive", () => {
	expect(maybePromptStar({ ...capture(), stateFile: stateFile(), env: { CI: "1" } })).toBe(false);

	const { stream } = capture(false);
	expect(maybePromptStar({ stream, stateFile: stateFile(), env: {} })).toBe(false);

	// requireTty: false lets a non-TTY (e.g. the Studio server) still show it once.
	const noTty = capture(false);
	expect(maybePromptStar({ stream: noTty.stream, stateFile: stateFile(), env: {}, requireTty: false })).toBe(true);
});

test("force overrides gating without persisting", () => {
	const file = stateFile();
	const { out, stream } = capture(false);
	const shown = maybePromptStar({ stream, stateFile: file, env: { CI: "1" }, force: true, persist: false });
	expect(shown).toBe(true);
	expect(out.join("")).toContain(REPO_URL);
	expect(existsSync(file)).toBe(false);
});

test("state merge preserves unrelated keys", () => {
	const file = stateFile();
	maybePromptStar({ stream: capture().stream, stateFile: file, env: {} });
	const saved = JSON.parse(readFileSync(file, "utf8"));
	expect(typeof saved.starPromptShownAt).toBe("string");
});
