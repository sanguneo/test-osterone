/**
 * One-time "star us on GitHub" prompt. Shown on the first human-facing run of the CLI or the
 * Studio server — never in `postinstall` (that runs in CI/Docker/sub-dependency installs where
 * nobody reads it). It records a flag in ~/.test-osterone/state.json so it appears exactly once,
 * and it stays silent under CI / opt-out env vars / non-interactive streams. Best-effort: it must
 * never break a real command, so every path is guarded and never throws.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const REPO_SLUG = "sanguneo/test-osterone";
export const REPO_URL = `https://github.com/${REPO_SLUG}`;

/** Env var a user sets to silence the prompt for good. */
export const STAR_OPT_OUT_ENV = "TESTOSTERONE_NO_NAG";

/** Shared runtime state file, alongside the other ~/.test-osterone files (projects, traces). */
export const STAR_STATE_FILE = join(homedir(), ".test-osterone", "state.json");

type Env = Record<string, string | undefined>;

interface WriteStream {
	write(chunk: string): unknown;
	isTTY?: boolean;
}

/** Env vars that silence the prompt: CI, generic opt-outs, and our own flag. */
export function starOptedOut(env: Env = process.env): boolean {
	return Boolean(env.CI || env[STAR_OPT_OUT_ENV] || env.DO_NOT_TRACK);
}

/** The message, as lines, so callers pick the newline and tests can assert on content. */
export function starPromptLines(url = REPO_URL): string[] {
	return [
		"",
		"★  test-osterone이 도움이 됐다면 GitHub에서 별 하나 부탁드려요!",
		"   If test-osterone helps you, a GitHub star means a lot:",
		`   ${url}`,
		`   (한 번만 표시됩니다 · turn this off with ${STAR_OPT_OUT_ENV}=1)`,
		"",
	];
}

interface StarState {
	starPromptShownAt?: string;
	[key: string]: unknown;
}

function readState(file: string): StarState {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		return raw && typeof raw === "object" ? (raw as StarState) : {};
	} catch {
		return {};
	}
}

/** Merge a patch into the state file (preserving unrelated keys). Best-effort. */
function writeState(file: string, patch: StarState): void {
	const next = { ...readState(file), ...patch };
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(next, null, 2));
}

/** Whether the prompt has already been shown on this machine. */
export function starAlreadyShown(file: string = STAR_STATE_FILE): boolean {
	return Boolean(readState(file).starPromptShownAt);
}

export interface MaybePromptStarOptions {
	/** Where to print (default process.stderr — keeps stdout clean for piping). */
	stream?: WriteStream;
	/** State file tracking the "shown once" flag. */
	stateFile?: string;
	/** Env used for opt-out checks. */
	env?: Env;
	/** Only prompt when the stream is an interactive TTY (default true). */
	requireTty?: boolean;
	/** Ignore opt-out / already-shown / TTY gating (for an explicit `star` command). */
	force?: boolean;
	/** Record the "shown" flag after printing (default true). */
	persist?: boolean;
}

/**
 * Print the star prompt at most once per machine. Returns true iff it printed.
 * Gating (unless `force`): opt-out env → TTY → already-shown.
 */
export function maybePromptStar(opts: MaybePromptStarOptions = {}): boolean {
	const {
		stream = process.stderr,
		stateFile = STAR_STATE_FILE,
		env = process.env,
		requireTty = true,
		force = false,
		persist = true,
	} = opts;
	try {
		if (!force) {
			if (starOptedOut(env)) return false;
			if (requireTty && !stream.isTTY) return false;
			if (starAlreadyShown(stateFile)) return false;
		}
		for (const line of starPromptLines()) stream.write(`${line}\n`);
		if (persist) writeState(stateFile, { starPromptShownAt: new Date().toISOString() });
		return true;
	} catch {
		return false;
	}
}
