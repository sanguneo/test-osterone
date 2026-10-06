import { homedir } from "node:os";
import { join } from "node:path";
import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

/**
 * Where Playwright keeps its browsers on this machine. The runner hands the app command only PATH, HOME and
 * the temp variables, and serve-studio points the home at a throwaway directory, so without this the Studio
 * looks for Chromium inside that empty home and every run ends in "Chromium is not installed".
 */
const browsersPath =
	process.env.PLAYWRIGHT_BROWSERS_PATH ??
	(process.platform === "win32"
		? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ms-playwright")
		: process.platform === "darwin"
			? join(homedir(), "Library", "Caches", "ms-playwright")
			: join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "ms-playwright"));

/**
 * Real-browser suite for the Studio (tester-army/e2e). The runner starts the Studio itself on a free
 * port with an isolated home (e2e/serve-studio.ts) and stops it when the run ends. `bun run test:e2e`
 * builds the UI first; the server only serves the built bundle.
 *
 * No agent is configured on purpose: every test here is a deterministic locator test, so the suite
 * needs no model and no credentials, and a green run means the same thing on every machine.
 */
const app = {
	url: "http://127.0.0.1:0",
	command: {
		executable: "node",
		args: ["--experimental-transform-types", "e2e/serve-studio.ts", "{port}"],
		log: ".e2e/logs/studio.log",
		env: { PLAYWRIGHT_BROWSERS_PATH: browsersPath },
	},
};

export default {
	tests: ["e2e/**/*.e2e.ts"],
	targets: [
		{ name: "desktop", engine: web({ viewport: { width: 1280, height: 800 } }), app },
		{ name: "phone", engine: web({ viewport: { width: 390, height: 844 } }), app },
	],
} satisfies E2EConfig;
