/**
 * Visual + runtime QA of the Studio in the user's real browser through BrowserSkill (`bsk`).
 *
 *   node --experimental-strip-types scripts/qa/bsk-studio-qa.ts [--browser <bsk instance>] [--fault]
 *
 * Spawns the Studio on a free port against an isolated home, seeds one project from the sample CSV
 * sheet, walks the project and its four views in an Agent Window, runs the sheet through the UI,
 * and writes .artifacts/bsk-qa/<timestamp>/report.json plus desktop and phone screenshots.
 * Exit 0 only when every landmark was found and no console error or failing request was seen.
 * `--fault` injects a deliberate failure (a 404 fetch and a console error) to prove the gate fails.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultBskRunner } from "../../src/execute/bsk-page.ts";
import { startFixture } from "../../src/testing/fixture-app.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STUDIO_BOOT_MS = 60_000;
const RUN_MS = 120_000;
const STEP_MS = 20_000;

interface Landmark {
	name: string;
	found: boolean;
	detail?: string;
}
interface RequestFailure {
	method: string;
	url: string;
	status: number | null;
	state: string;
}

const args = process.argv.slice(2);
const fault = args.includes("--fault");
const browserArg = args.includes("--browser") ? args[args.indexOf("--browser") + 1] : undefined;

const landmarks: Landmark[] = [];
const screenshots: { name: string; viewport: "desktop" | "phone"; path: string }[] = [];
let consoleErrors: string[] = [];
let failedRequests: RequestFailure[] = [];
const notes: string[] = [];

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(repo, ".artifacts", "bsk-qa", stamp);

function log(msg: string): void {
	console.log(`[qa:bsk] ${msg}`);
}

/** Same binary lookup as the BskPage backend (BSK_BIN, PATH, then the installer's ~/.local/bin). */
async function bsk(argv: string[]): Promise<string> {
	const { stdout, stderr, code } = await defaultBskRunner(argv);
	if (code !== 0) throw new Error(`bsk ${argv.join(" ")} failed: ${(stderr || stdout).trim().slice(0, 600)}`);
	return stdout;
}

async function bskJson(argv: string[]): Promise<unknown> {
	const out = await bsk([...argv, "--json"]);
	try {
		return JSON.parse(out);
	} catch {
		throw new Error(`bsk ${argv.join(" ")} returned non-JSON: ${out.slice(0, 300)}`);
	}
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => resolve(port));
		});
	});
}

function startStudio(port: number): Promise<ChildProcess> {
	const child = spawn(process.execPath, ["--experimental-strip-types", "e2e/serve-studio.ts", String(port)], {
		cwd: repo,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	return new Promise((resolve, reject) => {
		let seen = "";
		const timer = setTimeout(
			() => reject(new Error(`Studio did not announce itself within ${STUDIO_BOOT_MS}ms: ${seen.slice(-400)}`)),
			STUDIO_BOOT_MS,
		);
		const onData = (chunk: Buffer) => {
			seen += chunk.toString();
			if (seen.includes("test-osterone Studio →")) {
				clearTimeout(timer);
				resolve(child);
			}
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", (c: Buffer) => {
			seen += c.toString();
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`Studio exited early (code ${code}): ${seen.slice(-400)}`));
		});
	});
}

async function killTree(child: ChildProcess | undefined): Promise<void> {
	if (!child || child.exitCode !== null || !child.pid) return;
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	if (process.platform === "win32") {
		await new Promise<void>((resolve) =>
			execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => resolve()),
		);
	} else child.kill("SIGKILL");
	await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

/** One `@eN role "name"` line of a `bsk observe` tree. */
interface Node {
	ref: string;
	role: string;
	name: string;
}
function parseNodes(observed: string): Node[] {
	const nodes: Node[] = [];
	for (const line of observed.split(/\r?\n/)) {
		const m = line.match(/^\s*(@e\d+)\s+(\S+)\s+"(.*)"/);
		if (m?.[1] && m[2] !== undefined && m[3] !== undefined) nodes.push({ ref: m[1], role: m[2], name: m[3] });
	}
	return nodes;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Observe until `pick` returns a value, bounded by `deadlineMs`; each observe is itself the pacing. */
async function observeUntil<T>(
	session: string,
	pick: (observed: string, nodes: Node[]) => T | undefined,
	deadlineMs: number,
): Promise<{ value: T | undefined; observed: string }> {
	const end = Date.now() + deadlineMs;
	let observed = "";
	for (;;) {
		observed = await bsk(["observe", "--session", session]);
		const value = pick(observed, parseNodes(observed));
		if (value !== undefined) return { value, observed };
		if (Date.now() >= end) {
			return { value: undefined, observed };
		}
		await sleep(400);
	}
}

function record(name: string, found: boolean, detail?: string): boolean {
	landmarks.push({ name, found, ...(detail ? { detail } : {}) });
	log(`${found ? "ok     " : "MISSING"} ${name}${detail ? ` - ${detail}` : ""}`);
	return found;
}

async function shot(session: string, name: string, viewport: "desktop" | "phone"): Promise<void> {
	const path = join(outDir, `${String(screenshots.length + 1).padStart(2, "0")}-${viewport}-${name}.png`);
	await bsk(["screenshot", "--session", session, "--out", path]);
	if (existsSync(path)) screenshots.push({ name, viewport, path });
	else notes.push(`screenshot ${name} was not written`);
}

const has = (observed: string, ...texts: string[]) => texts.some((t) => observed.includes(t));

function entriesOf(json: unknown, keys: string[]): Record<string, unknown>[] {
	const root = json as Record<string, unknown> | unknown[];
	if (Array.isArray(root)) return root as Record<string, unknown>[];
	for (const holder of [root, root.data as Record<string, unknown> | undefined]) {
		for (const key of keys) {
			const v = holder?.[key];
			if (Array.isArray(v)) return v as Record<string, unknown>[];
		}
	}
	return [];
}

async function collectConsoleErrors(session: string, origin: string): Promise<string[]> {
	const found: string[] = [];
	let since: string | undefined;
	for (let page = 0; page < 20; page++) {
		const json = (await bskJson([
			"console",
			"--session",
			session,
			"--limit",
			"200",
			...(since ? ["--since", since] : []),
		])) as Record<string, unknown>;
		const entries = entriesOf(json, ["entries", "messages", "console"]);
		for (const e of entries) {
			// Entries from other origins (browser extensions, error pages) are not the Studio's.
			if (!String(e.url ?? origin).startsWith(origin)) continue;
			const level = String(e.level ?? e.type ?? e.kind ?? "").toLowerCase();
			if (/error|exception|assert/.test(level))
				found.push(`${level}: ${String(e.text ?? e.message ?? JSON.stringify(e)).slice(0, 300)}`);
		}
		const next = (json.next_since ?? json.next_cursor ?? json.next) as string | number | undefined;
		if (!entries.length || next === undefined || next === null) break;
		since = String(next);
	}
	return found;
}

async function collectFailedRequests(session: string, origin: string): Promise<RequestFailure[]> {
	const failed: RequestFailure[] = [];
	const seen = new Set<string>();
	let since: string | undefined;
	for (let page = 0; page < 30; page++) {
		const json = (await bskJson([
			"debug",
			"requests",
			"--session",
			session,
			"--kind",
			"all",
			"--limit",
			"100",
			...(since ? ["--since", since] : []),
		])) as Record<string, unknown>;
		const entries = entriesOf(json, ["requests", "items", "entries"]);
		for (const r of entries) {
			const url = String(r.url ?? "");
			if (!url.startsWith(origin)) continue;
			const id = String(r.id ?? r.request_id ?? `${r.method} ${url}`);
			const status = typeof r.status === "number" ? r.status : r.status != null ? Number(r.status) : null;
			const state = String(r.state ?? "");
			if (seen.has(id)) continue;
			if ((status !== null && status >= 400) || state === "failed" || state === "interrupted") {
				seen.add(id);
				failed.push({ method: String(r.method ?? "GET"), url, status, state });
			}
		}
		const next = (json.next_since ?? json.next) as string | number | undefined;
		if (!entries.length || next === undefined || next === null) break;
		since = String(next);
	}
	return failed;
}

async function pickBrowser(): Promise<string | undefined> {
	if (browserArg) return browserArg;
	const list = entriesOf(await bskJson(["browsers"]), ["browsers"]);
	const online = list.filter((b) => !b.unresponsive);
	if (list.length <= 1) return undefined;
	const first = online[0] ?? list[0];
	const id = String(first?.instance_id ?? "");
	log(`${list.length} browsers online and no --browser given; using ${id} (${String(first?.browser_name)})`);
	return id || undefined;
}

async function main(): Promise<number> {
	if (!existsSync(join(repo, "src", "app", "studio", "web", "dist", "index.html"))) {
		console.error("Studio UI is not built: run bun run studio:build");
		return 2;
	}
	mkdirSync(outDir, { recursive: true });

	let studio: ChildProcess | undefined;
	let fixture: Awaited<ReturnType<typeof startFixture>> | undefined;
	let session: string | undefined;
	let emulating = false;
	let origin = "";
	let fatal: string | undefined;

	try {
		const port = await freePort();
		origin = `http://localhost:${port}`;
		log(`starting Studio on ${origin}`);
		studio = await startStudio(port);
		fixture = await startFixture();

		const csvText = readFileSync(join(repo, "src", "testing", "sample-cases.csv"), "utf8");
		const projectName = "QA Project";
		const seeded = await fetch(`${origin}/api/projects`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: "qa-bsk",
				name: projectName,
				baseUrl: fixture.url,
				sheets: [{ id: "qa-sheet", name: "Sample sheet", kind: "csv", sheetUrl: "", csvText }],
			}),
		});
		if (!seeded.ok) throw new Error(`seeding the project failed: ${seeded.status} ${await seeded.text()}`);

		const browser = await pickBrowser();
		const started = (await bskJson(["session", "start", "--no-focus", ...(browser ? ["--browser", browser] : [])])) as {
			session_id?: string;
		};
		session = started.session_id;
		if (!session) throw new Error(`session start returned no session_id: ${JSON.stringify(started)}`);
		log(`bsk session ${session}`);

		await bsk(["debug", "start", "--session", session, "--name", "studio-qa"]);
		await bsk(["navigate", origin, "--session", session]);

		// 1. project list
		const home = await observeUntil(
			session,
			(o) => (has(o, "Projects", "프로젝트") && has(o, projectName) ? o : undefined),
			STEP_MS,
		);
		record("project list heading", has(home.observed, "Projects", "프로젝트"));
		const card = parseNodes(home.observed).find((n) => n.name.includes(projectName) && /button|link/.test(n.role));
		record(
			"seeded project card",
			home.value !== undefined,
			card ? `${card.role} ${card.ref}` : "no clickable card in observation",
		);
		await shot(session, "projects", "desktop");
		if (!card) throw new Error("cannot open the project: no clickable project card");
		await bsk(["click", card.ref, "--session", session]);

		// the project home lists its sheets; open the seeded one to reach the view rail
		const sheetName = "Sample sheet";
		const projectHome = await observeUntil(
			session,
			(o, nodes) =>
				o.includes(`heading "${projectName}"`)
					? nodes.find((n) => n.role === "button" && n.name.includes(sheetName))
					: undefined,
			STEP_MS,
		);
		record("project home", projectHome.value !== undefined, `heading "${projectName}" with sheet "${sheetName}"`);
		if (!projectHome.value) throw new Error("cannot open the sheet: project home did not render");
		await bsk(["click", projectHome.value.ref, "--session", session]);

		// 2. the four views
		const views: { key: string; navLabels: string[]; titles: string[] }[] = [
			{ key: "dashboard", navLabels: ["Dashboard", "실행 현황"], titles: ["Run overview", "실행 현황"] },
			{
				key: "rules",
				navLabels: ["Rules & interpretation", "규칙·해석"],
				titles: ["Rules & Interpretation", "규칙·해석"],
			},
			{ key: "run-results", navLabels: ["Run bench", "실행 작업대"], titles: ["Run workbench", "실행 작업대"] },
			{ key: "review", navLabels: ["Review queue", "리뷰 대기"], titles: ["Review queue", "리뷰 대기"] },
		];
		const openView = async (view: (typeof views)[number]): Promise<boolean> => {
			const { value, observed } = await observeUntil(
				session as string,
				(_o, nodes) => nodes.find((n) => n.role === "button" && view.navLabels.some((l) => n.name.startsWith(l))),
				STEP_MS,
			);
			void observed;
			if (!value) return false;
			await bsk(["click", value.ref, "--session", session as string]);
			const shown = await observeUntil(
				session as string,
				(o, nodes) =>
					nodes.some((n) => n.role === "heading" && view.titles.some((t) => n.name === t)) ||
					has(o, `heading "${view.titles[0]}"`, `heading "${view.titles[1]}"`)
						? o
						: undefined,
				STEP_MS,
			);
			return shown.value !== undefined;
		};

		for (const view of views) {
			if (view.key === "run-results") {
				record(`view title: ${view.key}`, await openView(view), view.titles.join(" | "));
				// start one run through the UI
				const { value: startBtn } = await observeUntil(
					session,
					(_o, nodes) => nodes.find((n) => n.role === "button" && /^(Start run|실행 시작|시작)/.test(n.name)),
					STEP_MS,
				);
				if (!startBtn) {
					record("run started through the UI", false, "no start button");
				} else {
					await bsk(["click", startBtn.ref, "--session", session]);
					const done = await observeUntil(
						session,
						(o) => {
							const m = o.match(/(Run complete|실행 완료)/);
							return m ? o : undefined;
						},
						RUN_MS,
					);
					record(
						"run finished",
						done.value !== undefined,
						done.value ? "run-complete banner shown" : "run did not finish before the deadline",
					);
					const tally = done.observed;
					const results = countResults(tally);
					record("run tally shows 4 results", results === 4, `tally total ${results}`);
				}
				await shot(session, view.key, "desktop");
				continue;
			}
			record(`view title: ${view.key}`, await openView(view), view.titles.join(" | "));
			await shot(session, view.key, "desktop");
		}

		// 3. back to the project view on a phone
		await openView(views[0] as (typeof views)[number]);
		emulating = true;
		await bsk(["emulate", "--session", session, "--device", "iphone-14"]);
		const phone = await observeUntil(session, (o) => (has(o, "Run overview", "실행 현황") ? o : undefined), STEP_MS);
		record("phone: project view renders", phone.value !== undefined);
		await shot(session, "dashboard", "phone");
		await bsk(["emulate", "--session", session, "--off"]);
		emulating = false;

		if (fault) {
			log("--fault: injecting a failing fetch and a console error");
			await bsk(["evaluate", "--session", session, "fetch('/api/does-not-exist').then((r) => r.status)"]);
			await bsk(["evaluate", "--session", session, "console.error('qa-bsk injected fault'); 1"]);
		}

		// 4. runtime evidence
		consoleErrors = await collectConsoleErrors(session, origin);
		failedRequests = await collectFailedRequests(session, origin);
	} catch (err) {
		fatal = err instanceof Error ? err.message : String(err);
		log(`ERROR ${fatal}`);
	} finally {
		if (session) {
			if (emulating) await bsk(["emulate", "--session", session, "--off"]).catch(() => undefined);
			await bsk(["debug", "stop", "--session", session]).catch(() => undefined);
			await bsk(["session", "stop", session]).catch((e: Error) => notes.push(`session stop: ${e.message}`));
		}
		await killTree(studio);
		try {
			await fixture?.stop();
		} catch (e) {
			notes.push(`fixture stop: ${(e as Error).message}`);
		}
	}

	const phoneShots = screenshots.filter((s) => s.viewport === "phone").length;
	const desktopShots = screenshots.filter((s) => s.viewport === "desktop").length;
	const pass =
		!fatal &&
		landmarks.length > 0 &&
		landmarks.every((l) => l.found) &&
		consoleErrors.length === 0 &&
		failedRequests.length === 0 &&
		desktopShots >= 5 &&
		phoneShots >= 1;
	const report = {
		timestamp: stamp,
		origin,
		fault,
		landmarks,
		consoleErrors,
		failedRequests,
		screenshots,
		...(fatal ? { error: fatal } : {}),
		...(notes.length ? { notes } : {}),
		verdict: pass ? "pass" : "fail",
	};
	writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

	console.log("");
	console.log(`landmarks: ${landmarks.filter((l) => l.found).length}/${landmarks.length} found`);
	for (const l of landmarks.filter((x) => !x.found)) console.log(`  missing: ${l.name}`);
	console.log(`console errors: ${consoleErrors.length}`);
	for (const e of consoleErrors) console.log(`  ${e}`);
	console.log(`failed requests: ${failedRequests.length}`);
	for (const r of failedRequests) console.log(`  ${r.method} ${r.url} -> ${r.status ?? r.state}`);
	console.log(`screenshots: ${desktopShots} desktop, ${phoneShots} phone`);
	for (const s of screenshots) console.log(`  ${s.path}`);
	if (fatal) console.log(`error: ${fatal}`);
	console.log(`report: ${join(outDir, "report.json")}`);
	console.log(`verdict: ${report.verdict}`);
	return pass ? 0 : 1;
}

/** Sum the per-verdict chips of the run summary ("Pass 1", "Fail 1", ...) in an observation. */
function countResults(observed: string): number {
	let total = 0;
	for (const m of observed.matchAll(/(?:Pass|Fail|Needs review|Error|통과|실패|검토 필요|오류)\s+(\d+)/g))
		total += Number(m[1]);
	return total;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error(err);
		process.exit(1);
	},
);
