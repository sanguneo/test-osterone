import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { startFixture } from "../../src/testing/fixture-app.ts";
import { CASES, createProjectAndRunSample, FLOW_TEST_TIMEOUT_MS } from "../support/flows.ts";

test("a project created in the UI runs its pasted sheet to the exact 2 pass / 1 fail / 1 review verdicts", {
	timeout: FLOW_TEST_TIMEOUT_MS,
}, async ({ app, screen, browser }) => {
	const fixture = await startFixture();
	try {
		await app.open("/");
		await createProjectAndRunSample(screen, fixture.url, "Run");

		// The bench's hand-off summary: one chip per verdict, in order, with the exact tally.
		await expect(browser.locator(".run-done .chip")).toHaveText(["Pass 2", "Fail 1", "Review 1", "Error 0"]);

		// Per-case verdicts live in the status view the bench hands off to.
		await screen.getByRole("button", /Open run status/).tap();
		await expect(screen.getByRole("button", "All 4")).toBeVisible({ timeout: 15_000 });
		const verdictOf = (title: string) =>
			screen.getByRole("row", { visible: true }).filter({ hasText: title }).getByRole("cell").nth(1);
		await expect(verdictOf(CASES.validLogin)).toHaveText("Pass");
		await expect(verdictOf(CASES.invalidLogin)).toHaveText("Pass");
		await expect(verdictOf(CASES.wrongPassword)).toHaveText("Fail");
		await expect(verdictOf(CASES.missingButton)).toHaveText("Review");
	} finally {
		fixture.stop();
	}
});
