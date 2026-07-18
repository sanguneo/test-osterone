#!/usr/bin/env bun

/**
 * test-osterone CLI entrypoint. `setup` installs runtime prerequisites (the headless
 * browser); real commands (rule, run, benchmark, dashboard) land in later phases.
 */

export const NAME = "test-osterone";
export const VERSION = "0.1.0";

export function help(): string {
	return [
		`${NAME} ${VERSION} — AI web test-automation (deterministic verdicts, sheet-driven cases)`,
		"",
		"commands:",
		"  setup                install runtime prerequisites (Playwright Chromium)",
		"  --version, -v        print version",
		"  --help, -h           show this help",
		"  (rule · run · benchmark · dashboard land in later phases)",
	].join("\n");
}

/** Install runtime prerequisites (the headless browser). Returns the child exit code. */
export async function runSetup(): Promise<number> {
	console.log(`${NAME}: installing Playwright Chromium…`);
	const proc = Bun.spawn(["bunx", "playwright", "install", "chromium"], { stdout: "inherit", stderr: "inherit" });
	const code = await proc.exited;
	console.log(
		code === 0
			? `${NAME}: setup complete.`
			: `${NAME}: setup failed (exit ${code}); re-run 'bun run setup' once network/permissions allow.`,
	);
	return code;
}

export async function main(argv: string[]): Promise<number> {
	const cmd = argv[0];
	if (cmd === "--version" || cmd === "-v") {
		console.log(VERSION);
		return 0;
	}
	if (cmd === "setup") return runSetup();
	if (cmd === undefined || cmd === "--help" || cmd === "-h" || cmd === "help") {
		console.log(help());
		return 0;
	}
	console.error(`unknown command: ${cmd}\n\n${help()}`);
	return 2;
}

if (import.meta.main) {
	main(process.argv.slice(2)).then((code) => process.exit(code));
}
