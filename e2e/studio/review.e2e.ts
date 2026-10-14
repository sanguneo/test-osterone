import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { startFixture } from "../../src/testing/fixture-app.ts";
import { CASES, createProjectAndRunSample, FLOW_TEST_TIMEOUT_MS, viewRail } from "../support/flows.ts";

test("after a run the review queue holds the self-heal case with its reason, and the nav badge counts it", {
	timeout: FLOW_TEST_TIMEOUT_MS,
}, async ({ app, screen }) => {
	const fixture = await startFixture();
	try {
		await app.open("/");
		await createProjectAndRunSample(screen, fixture.url, "Review");

		const reviewNav = viewRail(screen).getByRole("button", /^Review queue/);
		await expect(reviewNav.getByText("1")).toBeVisible({ timeout: 15_000 });
		await reviewNav.tap();

		await expect(screen.getByRole("heading", "Review queue")).toBeVisible();
		const items = screen.getByRole("article", { visible: true });
		await expect(items).toHaveCount(1, { timeout: 15_000 });
		const item = items.filter({ hasText: CASES.missingButton });
		await expect(item.getByText(CASES.missingButton)).toBeVisible();
		await expect(item.getByText("Reason for review")).toBeVisible();
		await expect(
			item.getByText(/^The 'Save changes' element couldn't be found, so the 'click' action was skipped\./),
		).toBeVisible();
		// The engine's own reason code, shown under the explanation.
		await expect(item.getByText("self-heal: click")).toBeVisible();
	} finally {
		fixture.stop();
	}
});
