import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/app/studio/web/src/App.tsx";
import { api } from "../src/app/studio/web/src/api.ts";
import { SheetEditorModal } from "../src/app/studio/web/src/components/SheetEditorModal.tsx";
import { getLang, setLang } from "../src/app/studio/web/src/i18n.ts";
import type { AnalyzeResult, Project, RunInput, TestSheet } from "../src/app/studio/web/src/types.ts";

const originalFetch = globalThis.fetch;
const originalLang = getLang();
const originalPath = window.location.pathname;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let restoreApi: (() => void) | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
	host = undefined;
	restoreApi?.();
	restoreApi = undefined;
	setLang(originalLang);
	window.history.replaceState(null, "", originalPath);
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

async function click(selector: string) {
	const button = host?.querySelector<HTMLButtonElement>(selector);
	if (!button) throw new Error(`Missing button: ${selector}`);
	await act(async () => button.click());
}

async function fill(selector: string, value: string) {
	const field = host?.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
	if (!field) throw new Error(`Missing field: ${selector}`);
	const prototype = field.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	await act(async () => {
		Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function mount(persisted: TestSheet[]) {
	setLang("en");
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<SheetEditorModal
				editSheet={null}
				projectId="onboarding"
				accounts={[]}
				onPersist={async (sheet) => {
					persisted.push(sheet);
				}}
				onAnalyzed={() => {}}
				onSave={(sheet) => {
					persisted.push(sheet);
				}}
				onClose={() => {}}
				onImportSheets={() => {}}
			/>,
		);
	});
	await click(".modes button:nth-child(2)");
	await fill("#sheet-name", "Mapped case");
	await fill("#sheet-csv", "Case label,What to do,What to see\nSign in,click Login,Dashboard");
}

const mapping = { title: "Case label", step: "What to do", expected: "What to see" };
const analysis: AnalyzeResult = {
	headers: Object.values(mapping),
	mapping,
	ruleVersion: 1,
	message: "",
	warnings: [],
	chat: [],
};

function network() {
	const answer = deferred<AnalyzeResult>();
	const started = deferred<void>();
	const previews: RunInput[] = [];
	const analyses: unknown[] = [];
	// Stub only this UI seam and restore it per test; another UI suite replaces the API module.
	const previous = { analyze: api.analyze, preview: api.preview };
	restoreApi = () => {
		Object.assign(api, previous);
	};
	api.analyze = (input) => {
		analyses.push(input);
		started.resolve();
		// An accidental effect loop must fail deterministically rather than keep the test alive.
		if (analyses.length > 2) return Promise.reject(new Error("unexpected-analysis-loop"));
		return answer.promise.then((result) => structuredClone(result));
	};
	api.preview = async (input) => {
		previews.push(input);
		// The preview must depend on the mapping supplied by the component, not just call order.
		const mapped = input.sheets?.[0]?.mapping?.step === mapping.step;
		return {
			headers: [],
			mapping: input.sheets?.[0]?.mapping ?? {},
			counts: { total: mapped ? 1 : 0, unique: mapped ? 1 : 0, duplicates: 0 },
			unique: mapped
				? [
						{
							caseId: "mapped-case",
							title: "Sign in",
							steps: ["click Login"],
							expected: "Dashboard",
							priority: null,
							category: null,
						},
					]
				: [],
			duplicates: [],
		};
	};
	return { answer, started, previews, analyses };
}

test("onboarding waits for analysis and carries its sheet mapping into preview and subsequent persistence", async () => {
	const net = network();
	const persisted: TestSheet[] = [];
	await mount(persisted);
	await click(".editor-actions .run");
	await net.started.promise;
	const prematurePreviews = net.previews.length;
	await act(async () => {
		net.answer.resolve(analysis);
	});
	expect(prematurePreviews).toBe(0);
	expect(net.previews).toHaveLength(1);
	expect(net.previews[0]?.sheets?.[0]?.mapping).toEqual(mapping);
	expect(host?.querySelector("tbody td")?.textContent).toBe("Sign in");
	await click(".editor-actions button:first-child");
	await click(".editor-actions .run");
	expect(persisted.at(-1)?.mapping).toEqual(mapping);
});

test("a rejected analysis shows failure without requesting a stale preview", async () => {
	const net = network();
	await mount([]);
	await click(".editor-actions .run");
	await net.started.promise;
	await act(async () => {
		net.answer.reject(new Error("analysis-unavailable"));
	});
	expect(host?.querySelector('[role="alert"]')).not.toBeNull();
	expect(net.previews).toEqual([]);
});

test.each([
	"none",
	"source",
	"rules",
])("App closes onboarding then runs with mapping, without duplicates (revisit=%s)", async (revisit) => {
	const net = network();
	const restoreNetwork = restoreApi;
	const previous = {
		projects: api.projects,
		saveProject: api.saveProject,
		status: api.status,
		history: api.history,
		reviewQueue: api.reviewQueue,
		activeRun: api.activeRun,
		runStream: api.runStream,
	};
	restoreApi = () => {
		Object.assign(api, previous);
		restoreNetwork?.();
	};
	let saved: Project = {
		id: "onboarding",
		name: "Onboarding",
		sheets: [],
		baseUrl: "https://example.test",
		env: "test",
		accounts: [],
		referenceRepo: "",
		aiInterpret: false,
		lenientMatch: false,
	};
	const saves: TestSheet[][] = [];
	const runs: RunInput[] = [];
	api.projects = async () => [structuredClone(saved)];
	api.saveProject = async (input) => {
		saved = { ...saved, sheets: structuredClone(input.sheets ?? []) };
		saves.push(structuredClone(saved.sheets));
		return { saved: structuredClone(saved), projects: [structuredClone(saved)] };
	};
	api.status = async () => ({
		connected: false,
		auth: null,
		projectId: saved.id,
		ruleVersion: 1,
		intents: {},
		mapping: {},
		warnings: [],
		chat: [],
	});
	api.history = async () => [];
	api.reviewQueue = async () => [];
	api.activeRun = async () => null;
	api.runStream = async (input) => {
		runs.push(input);
	};
	const analyze = api.analyze;
	api.analyze = async (input) => {
		const result = await analyze(input);
		// Match the server boundary: analysis persists mapping but never mutates a client snapshot.
		saved.sheets = saved.sheets.map((sheet) =>
			sheet.id === input.sheetId ? { ...sheet, mapping: structuredClone(result.mapping) } : sheet,
		);
		return result;
	};
	setLang("en");
	window.history.replaceState(null, "", "/p/onboarding");
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root?.render(<App />));
	await click(".dash-empty button");
	await click("dialog .modes button:nth-child(2)");
	await fill("#sheet-name", "Mapped case");
	await fill("#sheet-csv", "Case label,What to do,What to see\nSign in,click Login,Dashboard");
	await click("dialog .editor-actions .run");
	await net.started.promise;
	await act(async () => net.answer.resolve(analysis));
	expect(net.analyses).toHaveLength(1);
	if (revisit === "source") {
		await click("dialog .editor-actions button:first-child");
		await click("dialog .editor-actions .run");
	} else if (revisit === "rules") {
		await click("dialog .editor-actions .run");
		await click("dialog .editor-actions button:first-child");
	}
	await click("dialog .editor-actions button:last-child");
	expect(host.querySelector("dialog")).toBeNull();
	await click(".view-rail button:nth-child(3)");
	await click(".run-actions .primary");
	expect(runs).toHaveLength(1);
	expect(runs[0]?.sheets?.[0]?.mapping).toEqual(mapping);
	expect(saved.sheets).toHaveLength(1);
	for (const sheets of saves) expect(sheets).toHaveLength(1);
	expect(net.analyses).toHaveLength(revisit === "none" ? 1 : 2);
});

test("recognized sheet analysis and preview work through real HTTP without a connected model", async () => {
	const home = mkdtempSync(join(tmpdir(), "studio-onboarding-"));
	// Observe the real server's listening event, with OS-assigned port and isolated user state.
	const serverUrl = new URL("../src/app/studio/server.ts", import.meta.url).href;
	const child = spawn(
		"node",
		[
			"--experimental-transform-types",
			"--input-type=module",
			"--eval",
			`
		import http from "node:http";
		import { syncBuiltinESMExports } from "node:module";
		const createServer = http.createServer;
		http.createServer = (...args) => {
			const server = createServer(...args);
			server.once("listening", () => process.send({ port: server.address().port }));
			return server;
		};
		syncBuiltinESMExports();
		await import(${JSON.stringify(serverUrl)});
	`,
		],
		{
			env: { ...process.env, PORT: "0", HOME: home, USERPROFILE: home, CODEX_HOME: home, TMP: home, TEMP: home },
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		},
	);
	let output = "";
	child.stdout?.on("data", (chunk) => {
		output += String(chunk);
	});
	child.stderr?.on("data", (chunk) => {
		output += String(chunk);
	});
	try {
		const [message] = await once(child, "message", { signal: AbortSignal.timeout(10000) });
		const base = `http://127.0.0.1:${(message as { port: number }).port}`;
		const post = (path: string, body: unknown) =>
			originalFetch(`${base}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const sheet: TestSheet = {
			id: "sheet",
			name: "Recognized",
			kind: "csv",
			sheetUrl: "",
			csvText: "Title,Steps,Expected\nSign in,click Login,Dashboard",
		};
		expect((await post("/api/projects", { id: "onboarding", name: "Onboarding", sheets: [sheet] })).status).toBe(200);
		const status = (await originalFetch(`${base}/api/status?projectId=onboarding&sheetId=sheet`).then((response) =>
			response.json(),
		)) as { connected: boolean; ruleVersion: number; mapping: Record<string, string> };
		expect(status.connected).toBe(false);
		const response = await post("/api/sheet/analyze", {
			projectId: "onboarding",
			sheetId: sheet.id,
			csvText: sheet.csvText,
		});
		expect(response.status).toBe(200);
		const analyzed = (await response.json()) as AnalyzeResult;
		expect(analyzed.mapping).toEqual({ title: "Title", step: "Steps", expected: "Expected" });
		expect(analyzed.ruleVersion).toBe(status.ruleVersion);
		const previewResponse = await post("/api/tc/preview", {
			projectId: "onboarding",
			sheetId: sheet.id,
			sample: false,
			sheets: [{ ...sheet, mapping: analyzed.mapping }],
		});
		expect(previewResponse.status).toBe(200);
		const preview = (await previewResponse.json()) as { counts: { unique: number }; unique: { steps: string[] }[] };
		expect(preview.counts.unique).toBe(1);
		expect(preview.unique[0]?.steps).toEqual(["click Login"]);
		const projects = (await originalFetch(`${base}/api/projects`).then((response) => response.json())) as {
			id: string;
			sheets: TestSheet[];
		}[];
		expect(projects.find((project) => project.id === "onboarding")?.sheets[0]?.mapping).toEqual(analyzed.mapping);
		const after = (await originalFetch(`${base}/api/status?projectId=onboarding&sheetId=sheet`).then((result) =>
			result.json(),
		)) as { mapping: Record<string, string>; ruleVersion: number };
		expect(after.mapping).toEqual(status.mapping);
		expect(after.ruleVersion).toBe(status.ruleVersion);
		expect(
			(await post("/api/sheet/analyze", { projectId: "onboarding", sheetId: sheet.id, csvText: "Unknown,Other\na,b" }))
				.status,
		).toBe(400);
	} catch (error) {
		console.error(output);
		throw error;
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit", { signal: AbortSignal.timeout(5000) });
			child.kill();
			await exited;
		}
		rmSync(home, { recursive: true, force: true });
	}
}, 20000);
