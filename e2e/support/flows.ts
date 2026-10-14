/**
 * Shared Studio flows for the e2e suite: everything here is driven through the UI, the way a person
 * would do it, so a test that calls these is testing the screens, not the HTTP API behind them.
 *
 * The flows run the UI in English (the KO/EN toggle) so the locators read like the copy a reviewer
 * sees in a screenshot; the toggle itself is covered by e2e/studio/i18n.e2e.ts.
 */
import { readFileSync } from "node:fs";
import type { Screen } from "e2e";
import { expect } from "e2e";

/** The canonical 4-case sheet: TC1/TC2 pass, TC3 fail, TC4 needs_review against the fixture app. */
export const SAMPLE_CSV = readFileSync(new URL("../../src/testing/sample-cases.csv", import.meta.url), "utf8");

export const CASES = {
	validLogin: "Valid login shows welcome",
	invalidLogin: "Invalid login shows error",
	wrongPassword: "Wrong password must not pass as welcome",
	missingButton: "Missing button triggers self-heal gate",
} as const;

/** A run drives a real browser through four cases; give it room beyond the 5 s assertion default. */
export const RUN_TIMEOUT_MS = 180_000;
/** Whole-test budget for a flow that creates a project, adds a sheet and runs it. */
export const FLOW_TEST_TIMEOUT_MS = 300_000;

/** The Studio server is shared by every test of a target, so each test works in its own project. */
export function uniqueProjectName(prefix: string): string {
	return `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Switch the copy to English with the header toggle and wait until the page has re-rendered in it. */
export async function switchToEnglish(screen: Screen): Promise<void> {
	await screen.getByRole("button", "EN").tap();
	await expect(screen.getByRole("button", "EN")).toHaveAttribute("aria-pressed", "true");
}

/** Welcome → New Project → name + target URL → Save. Lands on the new project's home. */
export async function createProject(screen: Screen, name: string, targetUrl: string): Promise<void> {
	await screen.getByRole("button", /New Project/).tap();
	const dialog = screen.getByRole("dialog", "Project");
	await dialog.getByLabel("Name").fill(name);
	await dialog.getByLabel(/Test target site URL/).fill(targetUrl);
	await dialog.getByRole("button", "Save").tap();
	await expect(dialog).toBeHidden();
	await expect(screen.getByRole("heading", name)).toBeVisible();
}

/**
 * Project home → New Sheet → CSV source, pasted → Next → the interpretation step → Done.
 *
 * No model is connected in this suite, so the interpretation shown is the recognized-headers one;
 * the 4 unique cases it reports are what the run below executes.
 */
export async function addCsvSheet(screen: Screen, sheetName: string, csv: string): Promise<void> {
	await screen.getByRole("button", /New Sheet/).tap();
	const dialog = screen.getByRole("dialog", "Sheet");
	await dialog.getByRole("button", "CSV").tap();
	await dialog.getByLabel("Name").fill(sheetName);
	await dialog.getByLabel("CSV").fill(csv);
	await dialog.getByRole("button", "Next").tap();
	await expect(dialog.getByText("Column mapping")).toBeVisible({ timeout: 30_000 });
	await expect(dialog.getByText("Unique 4")).toBeVisible();
	await expect(dialog.getByText("Duplicates 0")).toBeVisible();
	await dialog.getByRole("button", "Done").tap();
	await expect(dialog).toBeHidden();
}

/** Open the run bench from the sheet's view rail, start the run, and wait for it to finish. */
export async function runSheet(screen: Screen): Promise<void> {
	await viewRail(screen)
		.getByRole("button", /Run bench/)
		.tap();
	await screen.getByRole("button", /Start run/).tap();
	await expect(screen.getByText("Run complete")).toBeVisible({ timeout: RUN_TIMEOUT_MS });
}

/** The sheet view rail (Dashboard / Rules / Run bench / Review queue). */
export function viewRail(screen: Screen) {
	return screen.getByRole("navigation", "Sheet view");
}

/** Everything a run-dependent test needs: an English UI, a project on the fixture app, the sample sheet, one finished run. */
export async function createProjectAndRunSample(screen: Screen, fixtureUrl: string, prefix: string): Promise<void> {
	await switchToEnglish(screen);
	await createProject(screen, uniqueProjectName(prefix), fixtureUrl);
	await addCsvSheet(screen, "Login cases", SAMPLE_CSV);
	await runSheet(screen);
}
