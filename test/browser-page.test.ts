import { expect, test } from "bun:test";

import { browserInstallHint } from "../src/execute/browser-page.ts";

test("browserInstallHint: maps Playwright's missing-executable error to an actionable install hint", () => {
	const pwError = [
		"browserType.launch: Executable doesn't exist at C:\\Users\\me\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win\\chrome.exe",
		"╔══════════════════════════════════════════════════════════╗",
		"║ Looks like Playwright Test or Playwright was just installed ║",
		"║ or updated. Please run the following command to download   ║",
		"║ new browsers:  npx playwright install                      ║",
		"╚══════════════════════════════════════════════════════════╝",
	].join("\n");
	const hint = browserInstallHint(pwError);
	expect(hint).not.toBeNull();
	expect(hint).toContain("playwright install chromium");
});

test("browserInstallHint: returns null for unrelated launch/runtime errors", () => {
	expect(browserInstallHint("net::ERR_CONNECTION_REFUSED at http://localhost:9999")).toBeNull();
	expect(browserInstallHint("Timeout 5000ms exceeded")).toBeNull();
	expect(browserInstallHint("")).toBeNull();
});
