/**
 * The model + reasoning level this machine is pinned to, persisted across restarts.
 *
 * Without it the Studio's auto-restore called `connect({ mode: "codex" })` with nothing pinned, so the
 * model came from whatever `~/.codex/config.toml` happened to say and the reasoning level was the
 * model's own default. That is not a setting so much as a draft: mid-session the model changed from
 * `gpt-5.6-sol` to `gpt-5.6-luna` on its own, every cached plan was re-authored by a different model,
 * and two scorecards that looked comparable were not. A verdict engine cannot have its authoring model
 * change underneath it without anyone choosing that.
 *
 * Stored alongside the other `~/.test-osterone` runtime files, merged so unrelated keys survive.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ModelPin {
	model?: string;
	/** Reasoning effort. A pinned level wins over every call site's `defaultEffort`. */
	reasoning?: string;
}

/** Shared runtime state file — the same one the star prompt records its flag in. */
export function pinFile(): string {
	return join(homedir(), ".test-osterone", "state.json");
}

function readAll(file: string): Record<string, unknown> {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** The pinned model/reasoning, or `{}` when nothing was ever chosen. Never throws. */
export function readModelPin(file = pinFile()): ModelPin {
	const raw = readAll(file).modelPin;
	if (!raw || typeof raw !== "object") return {};
	const { model, reasoning } = raw as Record<string, unknown>;
	return {
		...(typeof model === "string" && model.trim() ? { model: model.trim() } : {}),
		...(typeof reasoning === "string" && reasoning.trim() ? { reasoning: reasoning.trim() } : {}),
	};
}

/**
 * Record the choice. Best-effort: failing to remember a preference must never break a connection that
 * otherwise succeeded.
 */
export function writeModelPin(pin: ModelPin, file = pinFile()): void {
	try {
		const next = { ...readAll(file), modelPin: { ...readModelPin(file), ...pin } };
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(next, null, 2));
	} catch {}
}
