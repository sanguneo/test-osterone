/**
 * Vision fallback for assertions whose expected content is a visual state (color, icon,
 * image, badge, layout) rather than DOM text. When a text assertion fails deterministically,
 * the runner can ask the model to judge the case's screenshot instead. Best-effort and gated:
 * only runs when a vision-capable model + screenshot are available.
 */

import { createHash } from "node:crypto";
import type { ModelClient } from "../model/model-client.ts";

const VISION_SYSTEM =
	"You verify a web UI test expectation against a screenshot. The expectation may describe visual " +
	"state (color, icon, image, badge, layout, a popup) that does not appear in the page's DOM text. " +
	"Judge only what is visible. Answer with ONLY 'YES' if the screenshot clearly satisfies the " +
	"expectation, or 'NO' otherwise.";

/** Returns true when the model judges the screenshot satisfies the expected result. */
export async function visionAssert(model: ModelClient, screenshotDataUrl: string, expected: string): Promise<boolean> {
	const reply = await model.complete(
		[
			{ role: "system", content: VISION_SYSTEM },
			{
				role: "user",
				content: [
					{
						type: "text",
						text: `Expected result:\n${expected}\n\nDoes the screenshot satisfy this? Answer YES or NO.`,
					},
					{ type: "image", imageUrl: screenshotDataUrl },
				],
			},
		],
		// A yes/no read of one screenshot, fired per failing assertion — keep it cheap.
		{ defaultEffort: "low" },
	);
	const first = reply.trim().toLowerCase();
	return first.startsWith("yes") || first.startsWith("true") || first.startsWith("예") || first.startsWith("네");
}

/** One remembered vision judgement, in a shape a sheet's state file can hold. */
export interface VisionCacheEntry {
	key: string;
	ok: boolean;
}

export interface VisionCache {
	get(key: string): boolean | undefined;
	set(key: string, ok: boolean): void;
}

/**
 * Key a vision judgement by the case and the words it was asked about — never by the screenshot.
 *
 * Pixels are the wrong identity: the list behind the dialog carries a row count and a timestamp, so
 * two runs of the same case produce two different images and a screenshot hash would never hit.
 * The question being asked is what is stable, and it is the same question the assertion cache is
 * keyed on, invalidated the same way — a rule version bump or an edited case retires the answer.
 */
export function visionCacheKey(caseId: string, expected: string, ruleId: string, ruleVersion: number): string {
	const canonical = expected.replace(/\s+/g, " ").trim();
	const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
	return `vision|${ruleId}|v${ruleVersion}|${caseId}|${hash}`;
}

export class MemoryVisionCache implements VisionCache {
	private readonly store = new Map<string, boolean>();
	get(key: string): boolean | undefined {
		return this.store.get(key);
	}
	set(key: string, ok: boolean): void {
		this.store.set(key, ok);
	}

	/** Snapshot every remembered judgement for durable persistence. */
	entries(): VisionCacheEntry[] {
		return [...this.store.entries()].map(([key, ok]) => ({ key, ok }));
	}

	/** Replace remembered judgements from a persisted snapshot. */
	load(entries: VisionCacheEntry[]): void {
		this.store.clear();
		for (const { key, ok } of entries) if (typeof key === "string" && typeof ok === "boolean") this.store.set(key, ok);
	}
}
