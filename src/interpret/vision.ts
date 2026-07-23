/**
 * Vision fallback for assertions whose expected content is a visual state (color, icon,
 * image, badge, layout) rather than DOM text. When a text assertion fails deterministically,
 * the runner can ask the model to judge the case's screenshot instead. Best-effort and gated:
 * only runs when a vision-capable model + screenshot are available.
 */

import type { ModelClient } from "../model/model-client.ts";

const VISION_SYSTEM =
	"You verify a web UI test expectation against a screenshot. The expectation may describe visual " +
	"state (color, icon, image, badge, layout, a popup) that does not appear in the page's DOM text. " +
	"Judge only what is visible. Answer with ONLY 'YES' if the screenshot clearly satisfies the " +
	"expectation, or 'NO' otherwise.";

/** Returns true when the model judges the screenshot satisfies the expected result. */
export async function visionAssert(model: ModelClient, screenshotDataUrl: string, expected: string): Promise<boolean> {
	const reply = await model.complete([
		{ role: "system", content: VISION_SYSTEM },
		{
			role: "user",
			content: [
				{ type: "text", text: `Expected result:\n${expected}\n\nDoes the screenshot satisfy this? Answer YES or NO.` },
				{ type: "image", imageUrl: screenshotDataUrl },
			],
		},
	]);
	const first = reply.trim().toLowerCase();
	return first.startsWith("yes") || first.startsWith("true") || first.startsWith("예") || first.startsWith("네");
}
