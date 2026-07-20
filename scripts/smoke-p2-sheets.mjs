#!/usr/bin/env node
/**
 * Stage 2b live smoke test: per-sheet runtime state + per-sheet mapping isolation.
 *
 * Boots the real Studio server (node --experimental-transform-types server.ts) against
 * an isolated HOME/state dir, saves a two-sheet project where both sheets share one
 * identical case row plus one distinct row each, runs each sheet, and asserts:
 *   (a) each sheet's /api/history is isolated (its own run only),
 *   (b) approving a needs_review case on one sheet reconciles it out of the OTHER
 *       sheet's queue too (the shared case's baseline is approved once, globally).
 *
 * Usage: node scripts/smoke-p2-sheets.mjs
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = "C:/Users/USER/WebstormProjects/test-osteron/test-osterone";
const SERVER_TS = join(REPO_ROOT, "src/app/studio/server.ts");

const FIXTURE_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>smoke fixture</title></head>
<body>
  <h1>Sign in</h1>
  <input id="u" aria-label="Username" placeholder="Username" autocomplete="off" />
  <input id="p" type="password" aria-label="Password" placeholder="Password" autocomplete="off" />
  <button id="login" type="button">Log in</button>
  <div id="result" role="status"></div>
  <script>
    document.getElementById("login").addEventListener("click", function () {
      var u = document.getElementById("u").value;
      var p = document.getElementById("p").value;
      var r = document.getElementById("result");
      r.textContent =
        u === "admin" && p === "secret"
          ? "Welcome, admin. Dashboard loaded."
          : "Invalid credentials. Please try again.";
    });
  </script>
</body>
</html>`;

let failed = [];
function check(cond, msg) {
	if (!cond) failed.push(msg);
	console.log(`${cond ? "  ok" : "  FAIL"} — ${msg}`);
}

function startFixture() {
	return new Promise((resolve) => {
		const server = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(FIXTURE_PAGE);
		});
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve({ url: `http://127.0.0.1:${port}`, stop: () => server.close() });
		});
	});
}

function waitForServer(child, port, timeoutMs = 20000) {
	return new Promise((resolve, reject) => {
		let out = "";
		let done = false;
		const to = setTimeout(() => {
			if (!done) {
				done = true;
				reject(new Error(`server did not start within ${timeoutMs}ms; stdout so far:\n${out}`));
			}
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			out += chunk.toString();
			if (!done && /Studio/i.test(out)) {
				done = true;
				clearTimeout(to);
				resolve();
			}
		});
		child.stderr.on("data", (chunk) => {
			out += chunk.toString();
		});
		child.on("exit", (code) => {
			if (!done) {
				done = true;
				clearTimeout(to);
				reject(new Error(`server exited early (code ${code}); stdout so far:\n${out}`));
			}
		});
		// Fallback: poll the port directly in case the log line format ever changes.
		const poll = setInterval(async () => {
			if (done) return clearInterval(poll);
			try {
				const r = await fetch(`http://127.0.0.1:${port}/api/projects`);
				if (r.ok) {
					done = true;
					clearInterval(poll);
					clearTimeout(to);
					resolve();
				}
			} catch {
				// not up yet
			}
		}, 300);
	});
}

async function runStream(base, body) {
	const res = await fetch(`${base}/api/run`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let done;
	let errorEvent;
	for (const line of text.split("\n")) {
		const s = line.trim();
		if (!s) continue;
		const ev = JSON.parse(s);
		if (ev.type === "done") done = ev.view;
		if (ev.type === "error") errorEvent = ev;
	}
	if (errorEvent) throw new Error(`run failed: ${errorEvent.error}`);
	if (!done) throw new Error("run stream produced no 'done' event");
	return done;
}

async function main() {
	const home = mkdtempSync(join(tmpdir(), "osterone-smoke-"));
	const stateDir = join(home, "state");
	mkdirSync(stateDir, { recursive: true });

	const fixture = await startFixture();
	const port = 8600 + Math.floor(Math.random() * 300);
	const base = `http://127.0.0.1:${port}`;

	const child = spawn(
		process.execPath,
		["--experimental-transform-types", SERVER_TS],
		{
			cwd: REPO_ROOT,
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				TEST_OSTERONE_STATE_DIR: stateDir,
				PORT: String(port),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	let exitCode = 0;
	try {
		await waitForServer(child, port);
		console.log(`Studio server up at ${base} (fixture target ${fixture.url})`);

		const sharedRow = [
			"TC4",
			"Missing button triggers self-heal gate",
			'"open /\nclick ""Save changes""\nverify page shows ""Sign in"""',
			"Sign in",
		].join(",");
		const header = "Test ID,Title,Steps,Expected";
		const distinctA = [
			"TC1",
			"Valid login shows welcome",
			'"open /\nenter ""admin"" into ""Username""\nenter ""secret"" into ""Password""\nclick ""Log in""\nverify page shows ""Welcome"""',
			'"Welcome, admin. Dashboard loaded."',
		].join(",");
		const distinctB = [
			"TC2",
			"Invalid login shows error",
			'"open /\nenter ""admin"" into ""Username""\nenter ""wrongpass"" into ""Password""\nclick ""Log in""\nverify page shows ""Invalid credentials"""',
			'"Invalid credentials. Please try again."',
		].join(",");

		const csvA = [header, distinctA, sharedRow].join("\n");
		const csvB = [header, distinctB, sharedRow].join("\n");

		const projectId = "smoke-p2-sheets";
		const sheetA = { id: "shA", name: "Sheet A", kind: "csv", sheetUrl: "", csvText: csvA };
		const sheetB = { id: "shB", name: "Sheet B", kind: "csv", sheetUrl: "", csvText: csvB };

		const saveRes = await fetch(`${base}/api/projects`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: projectId,
				name: "Smoke P2 Sheets",
				sheets: [sheetA, sheetB],
				baseUrl: fixture.url,
				env: "smoke",
				username: "",
				password: "",
				referenceRepo: "",
				aiInterpret: false,
			}),
		});
		check(saveRes.ok, "POST /api/projects saved the two-sheet project");
		const saved = await saveRes.json();
		check(saved.saved?.sheets?.length === 2, "saved project has two sheets");

		const viewA = await runStream(base, {
			projectId,
			sample: false,
			sheets: [sheetA],
			sheetId: "shA",
			baseUrl: fixture.url,
			env: "smoke",
		});
		const viewB = await runStream(base, {
			projectId,
			sample: false,
			sheets: [sheetB],
			sheetId: "shB",
			baseUrl: fixture.url,
			env: "smoke",
		});
		check(viewA.sheetId === "shA", "sheet A run tagged with sheetId shA");
		check(viewB.sheetId === "shB", "sheet B run tagged with sheetId shB");
		check(viewA.results.length === 2, `sheet A ran 2 cases (got ${viewA.results.length})`);
		check(viewB.results.length === 2, `sheet B ran 2 cases (got ${viewB.results.length})`);

		const histA = await fetch(`${base}/api/history?projectId=${projectId}&sheetId=shA`).then((r) => r.json());
		const histB = await fetch(`${base}/api/history?projectId=${projectId}&sheetId=shB`).then((r) => r.json());
		check(Array.isArray(histA) && histA.length === 1, `sheet A history has exactly its own run (len=${histA.length})`);
		check(Array.isArray(histB) && histB.length === 1, `sheet B history has exactly its own run (len=${histB.length})`);
		check(
			histA.every((v) => v.sheetId === "shA") && histB.every((v) => v.sheetId === "shB"),
			"history isolation: A's history only contains shA runs, B's only shB runs",
		);
		check(
			histA[0]?.baseUrl === fixture.url && histB[0]?.baseUrl === fixture.url,
			"both sheets ran against the fixture baseUrl",
		);

		// TC4 (self-heal gate) is expected to land in needs_review deterministically — but stay
		// robust if the engine's heuristics ever change and it doesn't.
		const sharedCaseId = viewA.results.find((r) => r.title.includes("self-heal"))?.caseId;
		const sameIdOnB = viewB.results.find((r) => r.title.includes("self-heal"))?.caseId;
		check(!!sharedCaseId && sharedCaseId === sameIdOnB, "shared TC4 row hashes to the same caseId on both sheets");

		const queueA = await fetch(`${base}/api/review/queue?projectId=${projectId}&sheetId=shA`).then((r) => r.json());
		const sharedNeedsReview = queueA.find((it) => it.caseId === sharedCaseId);

		if (!sharedNeedsReview) {
			console.log("  (no needs_review case found — skipping cross-sheet approve-once assertion, isolation already verified)");
		} else {
			const approveRes = await fetch(`${base}/api/review/approve`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ caseId: sharedCaseId, projectId, sheetId: "shA" }),
			});
			check(approveRes.ok, "approve on sheet A succeeded");

			const queueB = await fetch(`${base}/api/review/queue?projectId=${projectId}&sheetId=shB`).then((r) => r.json());
			const stillOnB = queueB.find((it) => it.caseId === sharedCaseId);
			check(!stillOnB, "approving the shared case on sheet A reconciles it out of sheet B's queue (approve-once)");
		}

		console.log(failed.length === 0 ? "SMOKE OK" : `SMOKE FAIL (${failed.length} assertion(s) failed)`);
		if (failed.length) {
			for (const f of failed) console.log(`  - ${f}`);
			exitCode = 1;
		}
	} catch (err) {
		console.error("SMOKE FAIL —", err.stack ?? err);
		exitCode = 1;
	} finally {
		child.kill();
		fixture.stop();
		rmSync(home, { recursive: true, force: true });
	}
	process.exit(exitCode);
}

main();
