import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRepo, detectCodegraph, digestRepoDir, reconRepo, reduceRepo } from "../src/interpret/repo-recon.ts";
import { FakeModelClient, type ModelMessage } from "../src/model/model-client.ts";

const tmpDirs: string[] = [];

function makeFixtureRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "repo-recon-"));
	tmpDirs.push(root);
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "acme-web", scripts: { dev: "vite", build: "vite build" }, bin: { acme: "cli.js" } }),
	);
	writeFileSync(join(root, "AGENTS.md"), "# acme\n전자결재 웹앱. 로그인 후 결재 요청/승인.");
	writeFileSync(join(root, "README.md"), "# acme-web\nReact SPA for approvals.");
	mkdirSync(join(root, "src", "components"), { recursive: true });
	mkdirSync(join(root, "src", "pages"), { recursive: true });
	writeFileSync(
		join(root, "src", "App.tsx"),
		`const routes = [{ path: "/" }, { path: "/orders" }, { path: "/settings" }, { path: "/auth/login" }];\nexport const logo = "/logo.png";`,
	);
	writeFileSync(join(root, "src", "components", "OrdersTable.tsx"), "export function OrdersTable() { return null; }");
	writeFileSync(join(root, "src", "components", "index.ts"), "export * from './OrdersTable';");
	writeFileSync(join(root, "src", "pages", "SettingsPage.tsx"), "export function SettingsPage() { return null; }");
	// Noise that must be excluded from the scan:
	mkdirSync(join(root, "node_modules", "junk"), { recursive: true });
	writeFileSync(join(root, "node_modules", "junk", "index.ts"), "export const x = 1;");
	mkdirSync(join(root, "dist"), { recursive: true });
	writeFileSync(join(root, "dist", "bundle.js"), "console.log('built')");
	return root;
}

afterAll(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

test("digestRepoDir extracts name, docs, scripts, routes, components, and a clean file map", () => {
	const d = digestRepoDir(makeFixtureRepo());
	expect(d.name).toBe("acme-web");
	expect(d.agents).toContain("전자결재");
	expect(d.readme).toContain("React SPA");
	expect(d.scripts).toEqual(["dev", "build", "bin:acme"]);
	expect(d.routes).toEqual(["/auth/login", "/orders", "/settings"]);
	expect(d.components).toEqual(["OrdersTable", "SettingsPage"]);
	expect(d.files).toContain("src/App.tsx");
	expect(d.files).toContain("src/components/OrdersTable.tsx");
	expect(d.files.some((f) => f.includes("node_modules"))).toBe(false);
	expect(d.files.some((f) => f.startsWith("dist/"))).toBe(false);
});

test("digestRepoDir drops '/' and asset-ish paths from routes", () => {
	const d = digestRepoDir(makeFixtureRepo());
	expect(d.routes).not.toContain("/");
	expect(d.routes).not.toContain("/logo.png");
});

test("reduceRepo builds a digest prompt and returns the trimmed model brief", async () => {
	let seen = "";
	const model = new FakeModelClient((msgs: ModelMessage[]) => {
		seen = msgs.map((m) => m.content).join("\n");
		return "\n- React SPA 전자결재\n- 라우트: /orders, /settings\n";
	});
	const brief = await reduceRepo(digestRepoDir(makeFixtureRepo()), model);
	expect(brief).toBe("- React SPA 전자결재\n- 라우트: /orders, /settings");
	expect(seen).toContain("REPO acme-web");
	expect(seen).toContain("routes: /auth/login, /orders, /settings");
	expect(seen).toContain("src/components/OrdersTable.tsx");
	expect(seen).toContain("전자결재");
});

test("reduceRepo returns empty string for an empty digest (no model call)", async () => {
	let calls = 0;
	const model = new FakeModelClient(() => {
		calls++;
		return "unused";
	});
	const empty = mkdtempSync(join(tmpdir(), "repo-recon-empty-"));
	tmpDirs.push(empty);
	expect(await reduceRepo(digestRepoDir(empty), model)).toBe("");
	expect(calls).toBe(0);
});

test("detectCodegraph reports a boolean without throwing (absent tool degrades gracefully)", () => {
	expect(typeof detectCodegraph()).toBe("boolean");
});

test("acquireRepo uses a local directory in place (no clone)", () => {
	const repo = makeFixtureRepo();
	const cache = mkdtempSync(join(tmpdir(), "repo-recon-cache-"));
	tmpDirs.push(cache);
	expect(acquireRepo(repo, join(cache, "clone"))).toEqual({ dir: repo, mode: "local" });
});

test("acquireRepo reuses a populated cache dir instead of cloning a URL", () => {
	const cache = mkdtempSync(join(tmpdir(), "repo-recon-cache2-"));
	tmpDirs.push(cache);
	mkdirSync(join(cache, ".git"), { recursive: true });
	expect(acquireRepo("https://example.invalid/nope.git", cache)).toEqual({ dir: cache, mode: "cached" });
});

test("acquireRepo refresh drops an existing cache before re-cloning", () => {
	const cache = mkdtempSync(join(tmpdir(), "repo-recon-refresh-"));
	tmpDirs.push(cache);
	mkdirSync(join(cache, ".git"), { recursive: true });
	// no refresh → reuse the cache
	expect(acquireRepo("", cache)).toEqual({ dir: cache, mode: "cached" });
	// refresh → cache is removed first; with no source there is nothing to clone, so it throws
	expect(() => acquireRepo("", cache, { refresh: true })).toThrow();
	expect(existsSync(cache)).toBe(false);
});

test("acquireRepo refresh is a no-op for a local-path source (cache untouched)", () => {
	const repo = makeFixtureRepo();
	const cache = mkdtempSync(join(tmpdir(), "repo-recon-refresh-local-"));
	tmpDirs.push(cache);
	mkdirSync(join(cache, ".git"), { recursive: true });
	expect(acquireRepo(repo, cache, { refresh: true })).toEqual({ dir: repo, mode: "local" });
	expect(existsSync(join(cache, ".git"))).toBe(true);
});

test("reconRepo digests + reduces a local repo; CodeGraph stays optional (absent → file scan only)", async () => {
	const model = new FakeModelClient(() => "- 코드 브리프");
	const res = await reconRepo(makeFixtureRepo(), model, { query: "결재 요청 흐름", explore: () => null });
	expect(res.context).toBe("- 코드 브리프");
	expect(res.codegraph).toBe(false);
	expect(res.digest.routes).toContain("/orders");
	expect(res.notes.some((n) => n.includes("explore 결과 없음"))).toBe(true);
});

test("reconRepo folds an available CodeGraph explore into the digest + brief (optional layer present)", async () => {
	let seen = "";
	const model = new FakeModelClient((msgs) => {
		seen = msgs.map((m) => m.content).join("\n");
		return "- 코드 브리프 (CG)";
	});
	const res = await reconRepo(makeFixtureRepo(), model, {
		query: "결재",
		explore: () => "SYMBOL approveRequest at src/pages/SettingsPage.tsx",
	});
	expect(res.codegraph).toBe(true);
	expect(res.notes.some((n) => n.includes("codegraph explore 사용"))).toBe(true);
	expect(seen).toContain("codegraph explore:");
	expect(seen).toContain("approveRequest");
});

test("reconRepo skips the CodeGraph layer entirely when no query is given", async () => {
	const res = await reconRepo(makeFixtureRepo(), new FakeModelClient(() => "brief"), {});
	expect(res.codegraph).toBe(false);
	expect(res.notes.some((n) => n.includes("codegraph"))).toBe(false);
});
