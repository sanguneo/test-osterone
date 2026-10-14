/**
 * Dogfood: test-osterone tests its own Studio the way it tests any app.
 *
 * e2e/fixtures/studio-qc.csv is the Studio's QC written the way QA teams write it — free Korean prose, from
 * the README's Studio section (the product's 기획서). e2e/fixtures/studio-worksheet.xlsx is its 작업시트:
 * what `qc:worksheet` produced from that QC against the Studio source with a live model, reviewed and
 * committed, so the run itself needs no model and gives the same verdicts on every machine (author once,
 * then replay — the engine's own contract).
 *
 *   node --experimental-strip-types e2e/dogfood.ts              runs the committed 작업시트 (CI)
 *   node --experimental-strip-types e2e/dogfood.ts --from-qc    re-derives it from the prose QC with the
 *                                                               configured model (see src/model/cli-model.ts)
 *
 * Boots the Studio on a free port against a throwaway home (e2e/serve-studio.ts; needs bun run studio:build),
 * runs the harness against it, stops the Studio, and exits with the harness's code (0 every case passed).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			probe.close(() =>
				typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port")),
			);
		});
	});
}

function studioReady(studio: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		let output = "";
		const timer = setTimeout(() => reject(new Error(`Studio did not start within 60s:\n${output}`)), 60_000);
		studio.stdout?.on("data", (chunk) => {
			output += String(chunk);
			if (output.includes("test-osterone Studio")) {
				clearTimeout(timer);
				resolve();
			}
		});
		studio.stderr?.on("data", (chunk) => {
			output += String(chunk);
		});
		studio.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`Studio exited with ${code} before it was ready:\n${output}`));
		});
	});
}

async function main(): Promise<number> {
	if (!existsSync(join(repo, "src", "app", "studio", "web", "dist", "index.html"))) {
		console.error("dogfood: the Studio UI is not built — run bun run studio:build first.");
		return 2;
	}
	const port = await freePort();
	const studio = spawn(
		process.execPath,
		["--experimental-strip-types", join(repo, "e2e", "serve-studio.ts"), String(port)],
		{
			cwd: repo,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	try {
		await studioReady(studio);
		const harness = spawn(
			process.execPath,
			[
				"--experimental-strip-types",
				join(repo, "src", "app", "harness.ts"),
				"--spec",
				"README.md",
				"--repo",
				"src/app/studio/web/src",
				"--qc",
				process.argv.includes("--from-qc") ? "e2e/fixtures/studio-qc.csv" : "e2e/fixtures/studio-worksheet.xlsx",
				"--url",
				`http://127.0.0.1:${port}`,
				"--out",
				join(".e2e", "dogfood"),
			],
			{ cwd: repo, stdio: "inherit" },
		);
		return await new Promise<number>((resolve) => harness.once("exit", (code) => resolve(code ?? 2)));
	} finally {
		studio.kill();
	}
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		console.error(`dogfood: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 2;
	},
);
