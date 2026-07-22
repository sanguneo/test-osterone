/**
 * Repo code-context reconnaissance (author-time, optional). Given a reference
 * repo (a local path or a git URL), it builds a lightweight structural digest —
 * AGENTS.md / README excerpts, package scripts, detected routes, component/page
 * names, and a capped file map — then reduces it via the model seam into a
 * concise Korean code-context brief a human reviews and saves as a sheet's
 * `codeContext` (which feeds AI plan authoring alongside the live-recon domain
 * context).
 *
 * CodeGraph (github.com/colbymchenry/codegraph) is a STRICTLY OPTIONAL layer:
 * when the `codegraph` CLI is present it enriches the digest with an `explore`
 * result, otherwise the lightweight file scan stands alone. Nothing here is a
 * hard dependency — no tool, no network, no clone is required for the local-path
 * case, and every failure degrades to a note rather than an exception.
 *
 * Author-time only: never touches the deterministic run/verdict path. The digest
 * is a pure function of a directory, so it is unit-testable against a fixture.
 */

import { spawnSync } from "node:child_process";
import { type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import type { ModelClient } from "../model/model-client.ts";

export interface RepoDigest {
	name: string;
	agents: string;
	readme: string;
	scripts: string[];
	routes: string[];
	components: string[];
	files: string[];
	/** Optional CodeGraph `explore` output when the CLI is available. */
	codegraphExplore?: string;
}

export interface RepoDigestOptions {
	/** Max source files to walk (safety bound on huge repos). */
	maxFiles?: number;
	/** Max source files to read for route/vocabulary extraction. */
	maxRead?: number;
}

export interface RepoReconOptions extends RepoDigestOptions {
	/** Natural-language intent used for an optional `codegraph explore` query. */
	query?: string;
	/** Override the optional CodeGraph layer (testing / disabling); return null to skip. Defaults to auto-detection. */
	explore?: (dir: string, query: string) => string | null;
}

export interface RepoReconResult {
	digest: RepoDigest;
	/** Model-reduced Korean code-context brief (empty when there was nothing to say). */
	context: string;
	notes: string[];
	/** Whether the optional CodeGraph layer contributed. */
	codegraph: boolean;
}

export type AcquireMode = "local" | "cached" | "cloned";

const SKIP_DIRS = new Set([
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	"vendor",
	"target",
	"__pycache__",
	".codegraph",
]);
const SOURCE_EXT = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".vue",
	".svelte",
	".py",
	".go",
	".rs",
	".java",
	".kt",
	".rb",
	".php",
	".cs",
	".swift",
]);
const ROUTE_HINT = /rout|page|screen|view|nav|menu|app\b/i;
const COMPONENT_DIR = /(?:^|\/)(?:components?|pages?|views?|screens?|routes?)(?:\/|$)/i;
const DEFAULT_MAX_FILES = 4000;
const DEFAULT_MAX_READ = 60;

function readTextSafe(path: string, cap = 4000): string {
	try {
		return readFileSync(path, "utf8").slice(0, cap);
	} catch {
		return "";
	}
}

function firstExisting(dir: string, names: string[]): string {
	for (const name of names) {
		const p = join(dir, name);
		if (existsSync(p)) return p;
	}
	return "";
}

function collectFiles(root: string, maxFiles: number): string[] {
	const files: string[] = [];
	const walk = (abs: string): void => {
		if (files.length >= maxFiles) return;
		let entries: Dirent[] = [];
		try {
			entries = readdirSync(abs, { withFileTypes: true }) as Dirent[];
		} catch {
			return;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const e of entries) {
			if (files.length >= maxFiles) break;
			if (e.isDirectory()) {
				if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
				walk(join(abs, e.name));
			} else if (e.isFile() && SOURCE_EXT.has(extname(e.name).toLowerCase())) {
				files.push(relative(root, join(abs, e.name)).replace(/\\/g, "/"));
			}
		}
	};
	walk(root);
	files.sort((a, b) => a.localeCompare(b));
	return files;
}

function extractRoutes(root: string, files: string[], maxRead: number): string[] {
	const ranked = [...files].sort((a, b) => Number(ROUTE_HINT.test(b)) - Number(ROUTE_HINT.test(a)));
	const found = new Set<string>();
	for (const rel of ranked.slice(0, maxRead)) {
		const text = readTextSafe(join(root, rel), 40000);
		for (const m of text.matchAll(/["'`](\/[a-zA-Z0-9\-_/:.]*)["'`]/g)) {
			const route = m[1] ?? "";
			if (route.length < 2 || route.startsWith("//") || route.includes("..")) continue;
			if (/\.[a-z0-9]{2,4}$/i.test(route)) continue; // skip asset-ish paths
			found.add(route);
			if (found.size >= 40) break;
		}
		if (found.size >= 40) break;
	}
	return [...found].sort((a, b) => a.localeCompare(b));
}

function extractComponents(files: string[]): string[] {
	const seen = new Set<string>();
	for (const rel of files) {
		if (!COMPONENT_DIR.test(rel)) continue;
		const name = basename(rel, extname(rel));
		if (name && name.toLowerCase() !== "index") seen.add(name);
		if (seen.size >= 40) break;
	}
	return [...seen].sort((a, b) => a.localeCompare(b));
}

/** Build a structural digest of a repo directory — the unit-tested core of repo recon. */
export function digestRepoDir(dir: string, opts: RepoDigestOptions = {}): RepoDigest {
	const files = collectFiles(dir, opts.maxFiles ?? DEFAULT_MAX_FILES);
	let name = basename(dir.replace(/[\\/]+$/, "")) || "repo";
	const scripts: string[] = [];
	const pkgPath = join(dir, "package.json");
	if (existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
				name?: unknown;
				scripts?: Record<string, unknown>;
				bin?: unknown;
			};
			if (typeof pkg.name === "string" && pkg.name) name = pkg.name;
			if (pkg.scripts && typeof pkg.scripts === "object") scripts.push(...Object.keys(pkg.scripts));
			if (pkg.bin && typeof pkg.bin === "object")
				scripts.push(...Object.keys(pkg.bin as Record<string, unknown>).map((b) => `bin:${b}`));
		} catch {
			// malformed package.json — ignore, name falls back to the dir name
		}
	}
	return {
		name,
		agents: readTextSafe(firstExisting(dir, ["AGENTS.md", "agents.md"]), 1600),
		readme: readTextSafe(firstExisting(dir, ["README.md", "README", "readme.md"]), 1600),
		scripts: scripts.slice(0, 30),
		routes: extractRoutes(dir, files, opts.maxRead ?? DEFAULT_MAX_READ),
		components: extractComponents(files),
		files: files.slice(0, 150),
	};
}

function digestIsEmpty(d: RepoDigest): boolean {
	return (
		!d.agents &&
		!d.readme &&
		d.scripts.length === 0 &&
		d.routes.length === 0 &&
		d.components.length === 0 &&
		d.files.length === 0 &&
		!d.codegraphExplore
	);
}

const REPO_SYSTEM =
	"You are given a structural digest of an app's source repository (name, AGENTS.md/README excerpts, package scripts, " +
	"detected routes, component/page names, a file map, and optionally a CodeGraph exploration). Write a concise " +
	"code-context brief IN KOREAN that helps another AI author deterministic browser test steps: the app's apparent " +
	"structure and stack, key routes/pages, primary features and domain vocabulary drawn from the code, and login/entry " +
	"points if visible. Use 4-10 short bullet lines starting with '- '. Ground every statement in the digest — never " +
	"invent routes, features, or files that are not present. Output ONLY the bullets, no preamble or closing.";

function renderDigest(d: RepoDigest): string {
	const lines = [`REPO ${d.name}`];
	if (d.agents) lines.push(`AGENTS.md:\n${d.agents}`);
	if (d.readme) lines.push(`README:\n${d.readme}`);
	if (d.scripts.length) lines.push(`scripts: ${d.scripts.join(", ")}`);
	if (d.routes.length) lines.push(`routes: ${d.routes.join(", ")}`);
	if (d.components.length) lines.push(`components/pages: ${d.components.join(", ")}`);
	if (d.files.length) lines.push(`files:\n${d.files.map((f) => `- ${f}`).join("\n")}`);
	if (d.codegraphExplore) lines.push(`codegraph explore:\n${d.codegraphExplore}`);
	return lines.join("\n\n");
}

/** Reduce a repo digest into a concise Korean code-context brief via the model seam. */
export async function reduceRepo(digest: RepoDigest, model: ModelClient): Promise<string> {
	if (digestIsEmpty(digest)) return "";
	const reply = await model.complete([
		{ role: "system", content: REPO_SYSTEM },
		{ role: "user", content: renderDigest(digest) },
	]);
	return reply.trim();
}

/** Whether the optional `codegraph` CLI is available on this machine. */
export function detectCodegraph(): boolean {
	try {
		const r = spawnSync("codegraph", ["--version"], { encoding: "utf8", timeout: 10000, shell: true });
		return r.status === 0;
	} catch {
		return false;
	}
}

/** Best-effort `codegraph explore` for an NL query; returns null when unavailable or it fails. */
export function codegraphExplore(dir: string, query: string): string | null {
	try {
		// shell:true is needed on Windows to resolve the `codegraph` .cmd shim; sanitize the
		// query so no shell metacharacters from user input (project name / body.query) reach it.
		const safeQuery =
			query
				.replace(/[^\p{L}\p{N}\s._/-]/gu, " ")
				.trim()
				.slice(0, 200) || "overview";
		const r = spawnSync("codegraph", ["explore", safeQuery], {
			cwd: dir,
			encoding: "utf8",
			timeout: 60000,
			shell: true,
			maxBuffer: 4 * 1024 * 1024,
		});
		if (r.status !== 0 || !r.stdout) return null;
		return r.stdout.trim().slice(0, 6000) || null;
	} catch {
		return null;
	}
}

/**
 * Resolve a reference repo to a local directory. A local path is used in place;
 * a non-empty cache dir is reused; otherwise a shallow git clone is performed.
 * Requires `git` only for the clone branch.
 */
export function acquireRepo(
	source: string,
	cacheDir: string,
	opts: { token?: string } = {},
): { dir: string; mode: AcquireMode } {
	const src = source.trim();
	if (src && existsSync(src)) {
		try {
			if (statSync(src).isDirectory()) return { dir: src, mode: "local" };
		} catch {
			// fall through to clone handling
		}
	}
	if (existsSync(join(cacheDir, ".git"))) return { dir: cacheDir, mode: "cached" };
	if (!src) throw new Error("referenceRepo가 비어 있습니다.");
	mkdirSync(dirname(cacheDir), { recursive: true });
	const cloneUrl =
		opts.token && /^https:\/\//i.test(src) ? src.replace(/^https:\/\//i, `https://x-access-token:${opts.token}@`) : src;
	const r = spawnSync("git", ["clone", "--depth", "1", cloneUrl, cacheDir], { encoding: "utf8", timeout: 180000 });
	if (r.status !== 0) throw new Error(`git clone 실패: ${(r.stderr || r.stdout || "").slice(0, 300)}`);
	return { dir: cacheDir, mode: "cloned" };
}

/** Digest a repo directory (+ optional CodeGraph) and reduce it into a reviewable Korean code brief. */
export async function reconRepo(
	dir: string,
	model: ModelClient,
	opts: RepoReconOptions = {},
): Promise<RepoReconResult> {
	const notes: string[] = [];
	const digest = digestRepoDir(dir, opts);
	let codegraph = false;
	if (opts.query) {
		const explorer = opts.explore ?? (detectCodegraph() ? codegraphExplore : undefined);
		if (!explorer) {
			notes.push("codegraph 미설치 — 경량 파일 스캔만 사용(옵션)");
		} else {
			const explore = explorer(dir, opts.query);
			if (explore) {
				digest.codegraphExplore = explore;
				codegraph = true;
				notes.push("codegraph explore 사용(옵션 도구 감지됨)");
			} else {
				notes.push("codegraph 감지됐으나 explore 결과 없음 — 파일 스캔만 사용");
			}
		}
	}
	if (digestIsEmpty(digest)) notes.push("레포에서 소스/문서를 찾지 못함 — 경로를 확인하세요.");
	const context = await reduceRepo(digest, model);
	if (digest.files.length === 0 && !digest.agents && !digest.readme) {
		// nothing scanned; keep context empty and let the note explain
	} else if (!context) {
		notes.push("모델이 컨텍스트를 반환하지 않음 — 모델 연결/쿼터를 확인하세요.");
	}
	return { digest, context, notes, codegraph };
}
