import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModelPin, writeModelPin } from "../src/app/studio/model-pin.ts";

const tmpFile = (name: string): string => join(mkdtempSync(join(tmpdir(), "pin-")), name);

test("a pinned model and effort survive a restart", () => {
	// Auto-restore used to call connect() with nothing pinned, so the model came from whatever
	// ~/.codex/config.toml said. Mid-session it changed from gpt-5.6-sol to gpt-5.6-luna on its own,
	// every cached plan was re-authored by a different model, and two scorecards that looked
	// comparable were not.
	const file = tmpFile("state.json");
	writeModelPin({ model: "gpt-5.6-luna", reasoning: "high" }, file);
	expect(readModelPin(file)).toEqual({ model: "gpt-5.6-luna", reasoning: "high" });
});

test("pinning preserves unrelated keys in the shared state file", () => {
	// The same file carries the star prompt's flag; clobbering it would re-show a one-time prompt.
	const file = tmpFile("state.json");
	writeFileSync(file, JSON.stringify({ starPromptShownAt: "2026-07-01T00:00:00.000Z" }));
	writeModelPin({ model: "gpt-5.6-luna", reasoning: "high" }, file);
	const raw = JSON.parse(readFileSync(file, "utf8"));
	expect(raw.starPromptShownAt).toBe("2026-07-01T00:00:00.000Z");
	expect(raw.modelPin).toEqual({ model: "gpt-5.6-luna", reasoning: "high" });
	// A partial update keeps the other half rather than dropping it.
	writeModelPin({ reasoning: "medium" }, file);
	expect(readModelPin(file)).toEqual({ model: "gpt-5.6-luna", reasoning: "medium" });
});

test("no pin, or a corrupt one, reads as no choice rather than throwing", () => {
	// Absent means "nobody chose", which is what lets the caller fall back to the Codex config.
	expect(readModelPin(tmpFile("missing.json"))).toEqual({});
	const bad = tmpFile("bad.json");
	writeFileSync(bad, "{ not json");
	expect(readModelPin(bad)).toEqual({});
	const wrongShape = tmpFile("shape.json");
	writeFileSync(wrongShape, JSON.stringify({ modelPin: { model: 42, reasoning: "  " } }));
	expect(readModelPin(wrongShape)).toEqual({});
	// An unwritable path must not break a connection that otherwise succeeded.
	expect(() => writeModelPin({ model: "x" }, join(tmpFile("d.json"), "nested", "state.json"))).not.toThrow();
});
