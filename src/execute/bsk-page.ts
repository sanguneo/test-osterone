/**
 * BrowserSkill-backed `Page`: runs QC cases inside the user's real, logged-in Chrome/Edge through the
 * `bsk` CLI instead of a Playwright-launched browser. Same contract as `BrowserPage`, so the runner and
 * verdict logic are unchanged.
 *
 * Every command goes through an injectable `BskRunner`, so the adapter is unit-testable without a
 * browser. Label resolution mirrors `BrowserPage` (role/label/placeholder -> text -> flex text -> css),
 * but runs inside the page via `bsk evaluate`: the chosen element is tagged with a unique data
 * attribute and then acted on with `bsk click` / `bsk fill`, which send trusted input. Nothing matching
 * is an error, never a silent success — the runner turns it into a heal event.
 *
 * Deliberately NOT implemented:
 * - `resetSession()`: it would clear cookies and storage in the user's real browser profile, signing
 *   them out of whatever the site is. Login-feature cases therefore run against the session as found.
 * - `requestFailures()` / `serverWrites()`: `bsk debug` capture is an opt-in, session-wide recording
 *   with cursors and budgets, not a cheap per-step ring; wiring it in is a separate piece of work.
 * - `dismissOverlays()` / `clickRow()`: optional, and the runner reports their absence.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PHRASES, withoutUiNoun } from "../interpret/rule.ts";
import { bestFieldMatch, type FieldEntry, looksLikeCss } from "./browser-page.ts";
import type { Page, PageSnapshot } from "./page.ts";

export type BskRunner = (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface BskPageOptions {
	baseUrl: string;
	/** Browser instance id or unique label (`bsk browsers`). Required when more than one browser is online. */
	browser?: string;
	timeoutMs?: number;
	/** Attach a PNG to snapshots that ask for one. Off by default: each one is an extra bsk round trip. */
	screenshot?: boolean;
	run?: BskRunner;
}

function execBsk(
	bin: string,
	args: string[],
): Promise<{ stdout: string; stderr: string; code: number; missing: boolean }> {
	return new Promise((resolve) => {
		execFile(bin, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
			const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
			const spawnError = err && typeof err.code !== "number" ? `${err.message}\n` : "";
			const missing = err?.code === "ENOENT";
			resolve({ stdout: String(stdout), stderr: `${spawnError}${String(stderr)}`, code, missing });
		});
	});
}

/**
 * Spawn `bsk` directly (no shell), reporting a non-zero exit as data rather than a rejection.
 *
 * `BSK_BIN` overrides the binary. Otherwise `bsk` is looked up on PATH, and when that lookup fails the
 * installer's default location (`~/.local/bin`) is tried once. Measured on this Windows machine: a PATH
 * entry with a stray trailing quote makes Node's (libuv's) PATH search miss `bsk.exe` entirely while a
 * shell still finds it, so a PATH-only lookup is not enough here.
 */
export const defaultBskRunner: BskRunner = async (args) => {
	const override = process.env.BSK_BIN;
	const first = await execBsk(override ?? "bsk", args);
	if (!first.missing || override) return { stdout: first.stdout, stderr: first.stderr, code: first.code };
	const fallback = join(homedir(), ".local", "bin", process.platform === "win32" ? "bsk.exe" : "bsk");
	const second = await execBsk(fallback, args);
	return { stdout: second.stdout, stderr: second.stderr, code: second.code };
};

const FILLABLE_CSS =
	'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"], [contenteditable=""]';

/** Attribute a resolver puts on the element it chose; the value is unique per action. */
const TAG_ATTR = "data-osteron-bsk";

interface FormRead {
	fields: Record<string, string>;
	controls: Record<string, boolean>;
	limits: Record<string, number>;
	writable: FieldEntry[];
	clickables: string[];
	landed?: string;
}

/*
 * In-page functions. They are serialized with `Function.prototype.toString` and evaluated in the page,
 * so they must be self-contained (no imports, no closures over module scope) and comment-free inside
 * their bodies to keep the argv short.
 */

/** Same reading rules as `BrowserPage.readForm`: keys, dedup, maxlength, toggles, writable aliases, clickables. */
function readFormInPage(arg: { mark: boolean; fillable: string; landedAttr: string }): FormRead {
	const fields: Record<string, string> = {};
	const controls: Record<string, boolean> = {};
	const limits: Record<string, number> = {};
	let landed: string | undefined;
	const writable: FieldEntry[] = [];
	const text = (s: string | null | undefined) => (s ?? "").trim();
	const rowLabel = (el: Element): string => {
		for (let row = el.parentElement; row && row !== document.body; row = row.parentElement) {
			if (row.querySelectorAll(arg.fillable).length > 1) return "";
			let found = "";
			for (const l of row.children) {
				if (l.tagName !== "LABEL" && l.tagName !== "LEGEND") continue;
				if (l.getAttribute("for") || l.querySelector("input,select,textarea")) continue;
				if (!(l.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
				found = text(l.textContent) || found;
			}
			if (found) return found;
		}
		return "";
	};
	const nodes = document.querySelectorAll<HTMLElement>(
		'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, [contenteditable="true"]',
	);
	let i = 0;
	for (const el of nodes) {
		const id = el.getAttribute("id");
		const byFor = id ? text(document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent) : "";
		const wrapping = text(el.closest("label")?.textContent);
		const row = rowLabel(el);
		const key =
			byFor ||
			wrapping ||
			row ||
			text(el.getAttribute("aria-label")) ||
			text(el.getAttribute("placeholder")) ||
			text(el.getAttribute("name")) ||
			el.tagName.toLowerCase();
		const v = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el.innerText ?? "");
		const finalKey = key in fields ? `${key}#${++i}` : key;
		fields[finalKey] = v;
		if (el.hasAttribute(arg.landedAttr)) landed = finalKey;
		if (el instanceof HTMLInputElement && el.maxLength >= 0) limits[finalKey] = el.maxLength;
		if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")) {
			controls[key in controls ? `${key}#${++i}` : key] = el.checked;
			continue;
		}
		if (!el.matches(arg.fillable)) continue;
		const r = el.getBoundingClientRect();
		if (!r.width || !r.height) continue;
		const index = writable.length;
		if (arg.mark) el.setAttribute("data-osteron-field", String(index));
		writable.push({
			index,
			key: finalKey,
			names: [
				byFor,
				wrapping,
				row,
				text(el.getAttribute("aria-label")),
				text(el.getAttribute("placeholder")),
				text(el.getAttribute("name")),
				text(el.getAttribute("title")),
				text(id),
			].filter(Boolean),
		});
	}
	const clickable = (el: Element): boolean =>
		el.tagName === "BUTTON" ||
		el.tagName === "A" ||
		el.getAttribute("role") === "button" ||
		el.hasAttribute("onclick") ||
		getComputedStyle(el).cursor === "pointer";
	const clickables: string[] = [];
	for (const el of document.querySelectorAll("*")) {
		const r = el.getBoundingClientRect();
		if (r.width < 6 || r.height < 6 || !clickable(el)) continue;
		if ([...el.children].some((c) => clickable(c))) continue;
		const own = text(el.textContent) || text(el.getAttribute("aria-label"));
		if (own && own.length <= 40 && !clickables.includes(own)) clickables.push(own);
	}
	return { fields, controls, limits, writable, landed, clickables };
}

/**
 * Find the element a human label names and tag it, polling until `timeoutMs` (Playwright auto-waits the
 * same way). Click ranking: named interactive role / label / placeholder, then smallest element whose
 * text contains the target, then whitespace-tolerant text, then raw css when the target is one. Fill
 * ranking: label / placeholder / name / id / title / aria-label restricted to writable elements, then
 * the whitespace-tolerant label/placeholder, then raw css. Each target (as written, then with its UI
 * noun stripped) is exhausted before the next. Hidden elements never match; a match that stays disabled
 * is reported as such, because clicking it would be a success the app never saw.
 */
function resolveInPage(arg: {
	targets: { text: string; css: boolean }[];
	mode: "click" | "fill";
	fillable: string;
	attr: string;
	tag: string;
	timeoutMs: number;
}): Promise<{ found: boolean; disabled?: boolean }> {
	const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
	const squish = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, "");
	const visible = (el: Element) => {
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
	};
	const flex = (t: string): RegExp | null => {
		const sq = squish(t);
		if (sq.length < 2) return null;
		return new RegExp(
			sq
				.split("")
				.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
				.join("\\s*"),
		);
	};
	const labelText = (el: Element): string => {
		const parts: string[] = [];
		const labels = (el as HTMLInputElement).labels;
		if (labels) for (const l of labels) parts.push(l.textContent ?? "");
		const by = el.getAttribute("aria-labelledby");
		if (by) for (const id of by.split(/\s+/)) parts.push(document.getElementById(id)?.textContent ?? "");
		parts.push(el.getAttribute("aria-label") ?? "");
		return parts.join(" ");
	};
	const roleName = (el: Element): string => {
		const aria = el.getAttribute("aria-label");
		if (aria) return aria;
		const own = labelText(el);
		if (own.trim()) return own;
		if (el instanceof HTMLInputElement) return el.value || el.title;
		return el.textContent || el.getAttribute("title") || "";
	};
	const disabled = (el: Element) =>
		(el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";
	const all = (css: string) => [...document.querySelectorAll(css)].filter(visible);
	const ROLE_CSS =
		'button, a[href], input[type="button"], input[type="submit"], input[type="reset"], input[type="checkbox"], input[type="radio"], input[type="image"], [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"]';
	const smallestByText = (test: (t: string) => boolean): Element | undefined => {
		let best: Element | undefined;
		let bestLen = Number.POSITIVE_INFINITY;
		for (const el of all("body *")) {
			if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
			const t = el.textContent ?? "";
			if (!test(t) || t.length >= bestLen) continue;
			best = el;
			bestLen = t.length;
		}
		return best;
	};
	const findClick = (t: { text: string; css: boolean }): Element | undefined => {
		const want = norm(t.text);
		if (!want) return undefined;
		const named =
			all(ROLE_CSS).find((el) => norm(roleName(el)).includes(want)) ??
			all("input, textarea, select, [contenteditable]").find((el) => norm(labelText(el)).includes(want)) ??
			all("[placeholder]").find((el) => norm(el.getAttribute("placeholder")).includes(want));
		if (named) return named;
		const byText = smallestByText((s) => norm(s).includes(want));
		if (byText) return byText;
		const re = flex(t.text);
		const byFlex = re ? smallestByText((s) => re.test(s)) : undefined;
		if (byFlex) return byFlex;
		if (t.css) {
			try {
				return all(t.text)[0];
			} catch {
				return undefined;
			}
		}
		return undefined;
	};
	const findFill = (t: { text: string; css: boolean }): Element | undefined => {
		const want = norm(t.text);
		if (!want) return undefined;
		const writable = all(arg.fillable);
		const exactAttr = (el: Element) => ["name", "id", "title", "aria-label"].some((a) => el.getAttribute(a) === t.text);
		const hit =
			writable.find((el) => norm(labelText(el)).includes(want)) ??
			writable.find((el) => norm(el.getAttribute("placeholder")).includes(want)) ??
			writable.find(exactAttr);
		if (hit) return hit;
		const re = flex(t.text);
		if (re) {
			const byFlex = writable.find((el) => re.test(labelText(el)) || re.test(el.getAttribute("placeholder") ?? ""));
			if (byFlex) return byFlex;
		}
		if (t.css) {
			try {
				return all(t.text).filter((el) => el.matches(arg.fillable))[0];
			} catch {
				return undefined;
			}
		}
		return undefined;
	};
	const find = arg.mode === "click" ? findClick : findFill;
	const deadline = Date.now() + arg.timeoutMs;
	return new Promise((resolve) => {
		const attempt = () => {
			for (const stale of document.querySelectorAll(`[${arg.attr}]`)) stale.removeAttribute(arg.attr);
			let sawDisabled = false;
			for (const t of arg.targets) {
				const el = find(t);
				if (!el) continue;
				if (arg.mode === "click" && disabled(el)) {
					sawDisabled = true;
					continue;
				}
				el.setAttribute(arg.attr, arg.tag);
				resolve({ found: true });
				return;
			}
			if (Date.now() >= deadline) {
				resolve({ found: false, disabled: sawDisabled });
				return;
			}
			setTimeout(attempt, 100);
		};
		attempt();
	});
}

/** Wait for the first paint of a client-rendered app, like `BrowserPage.settleApp`. Never rejects. */
function settleInPage(arg: { timeoutMs: number }): Promise<boolean> {
	const deadline = Date.now() + arg.timeoutMs;
	return new Promise((resolve) => {
		const check = () => {
			const b = document.body;
			if (b && ((b.innerText || "").trim().length > 0 || b.querySelector("input,textarea,button,a,table,img,svg"))) {
				resolve(true);
				return;
			}
			if (Date.now() >= deadline) {
				resolve(false);
				return;
			}
			setTimeout(check, 50);
		};
		check();
	});
}

/** Wrap an in-page function and its JSON argument into one expression for `bsk evaluate`. */
function call(fn: (...args: never[]) => unknown, arg: unknown): string {
	return `(${fn.toString()})(${JSON.stringify(arg)})`;
}

/** Pull a human-readable reason out of a failed bsk command's JSON or stderr. */
function failureReason(res: { stdout: string; stderr: string; code: number }): string {
	try {
		const j = JSON.parse(res.stdout) as { message?: string; code?: string };
		if (j.message) return j.code ? `${j.code}: ${j.message}` : j.message;
	} catch {
		// not JSON — fall through to stderr
	}
	return (res.stderr || res.stdout).trim() || `exit code ${res.code}`;
}

export class BskPage implements Page {
	private closed = false;
	private seq = 0;

	private readonly run: BskRunner;
	readonly sessionId: string;
	private readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly screenshotEnabled: boolean;
	private readonly phrases: Record<string, string[]>;
	private constructor(
		run: BskRunner,
		sessionId: string,
		baseUrl: string,
		timeoutMs: number,
		screenshotEnabled: boolean,
		phrases: Record<string, string[]>,
	) {
		this.run = run;
		this.sessionId = sessionId;
		this.baseUrl = baseUrl;
		this.timeoutMs = timeoutMs;
		this.screenshotEnabled = screenshotEnabled;
		this.phrases = phrases;
	}

	static async create(opts: BskPageOptions): Promise<BskPage> {
		const run = opts.run ?? defaultBskRunner;
		const args = ["session", "start", "--no-focus", "--json"];
		if (opts.browser) args.push("--browser", opts.browser);
		const res = await run(args);
		if (res.code !== 0) throw new Error(`bsk session start failed — ${failureReason(res)}`);
		let sessionId: string | undefined;
		try {
			sessionId = (JSON.parse(res.stdout) as { session_id?: string }).session_id;
		} catch {
			// handled below
		}
		if (!sessionId) throw new Error(`bsk session start returned no session_id: ${res.stdout.trim().slice(0, 200)}`);
		return new BskPage(run, sessionId, opts.baseUrl, opts.timeoutMs ?? 5000, !!opts.screenshot, { ...DEFAULT_PHRASES });
	}

	/** Run a session-scoped bsk command; a non-zero exit throws with bsk's own reason. */
	private async bsk(args: string[]): Promise<unknown> {
		if (this.closed) throw new Error("BskPage is closed");
		const res = await this.run([...args, "--session", this.sessionId, "--json"]);
		if (res.code !== 0) throw new Error(`bsk ${args[0]} failed — ${failureReason(res)}`);
		try {
			return JSON.parse(res.stdout);
		} catch {
			return res.stdout;
		}
	}

	/** Evaluate an expression in the page; a thrown page error (`ok: false`) is an error here too. */
	private async evaluate<T>(expression: string, timeoutMs = this.timeoutMs): Promise<T> {
		const out = (await this.bsk(["evaluate", expression, "--timeout", `${timeoutMs + 5000}ms`])) as {
			ok?: boolean;
			value?: T;
			error?: { text?: string };
		};
		if (out?.ok !== true) throw new Error(`page evaluate failed — ${out?.error?.text ?? "no result"}`);
		return out.value as T;
	}

	private async untag(attr: string): Promise<void> {
		await this.evaluate(
			`(()=>{for(const e of document.querySelectorAll(${JSON.stringify(`[${attr}]`)}))e.removeAttribute(${JSON.stringify(attr)});return true})()`,
		).catch(() => {});
	}

	async goto(path: string): Promise<void> {
		const url = new URL(path, this.baseUrl).href;
		// `--wait-until load` is bsk's default; domcontentloaded matches BrowserPage, and the settle below
		// waits for a client-rendered app's first paint the same way.
		await this.bsk(["navigate", url, "--wait-until", "domcontentloaded", "--timeout", `${this.timeoutMs}ms`]);
		await this.evaluate<boolean>(call(settleInPage, { timeoutMs: this.timeoutMs })).catch(() => false);
	}

	async landing(): Promise<{ url: string; status: number | null }> {
		return await this.evaluate<{ url: string; status: number | null }>(
			'(()=>{const n=performance.getEntriesByType("navigation")[0];const s=n&&n.responseStatus;return {url:location.href,status:typeof s==="number"&&s>0?s:null}})()',
		);
	}

	/** Targets in resolution order: as written, then with a trailing UI noun removed. */
	private targets(target: string): { text: string; css: boolean }[] {
		const out = [{ text: target, css: looksLikeCss(target) }];
		const stripped = withoutUiNoun(target, { phrases: this.phrases });
		if (stripped && stripped !== target) out.push({ text: stripped, css: looksLikeCss(stripped) });
		return out;
	}

	private async resolve(
		target: string,
		mode: "click" | "fill",
		timeoutMs: number,
	): Promise<{ selector: string; tag: string } | { disabled: boolean }> {
		const tag = `${++this.seq}`;
		const res = await this.evaluate<{ found: boolean; disabled?: boolean }>(
			call(resolveInPage, {
				targets: this.targets(target),
				mode,
				fillable: FILLABLE_CSS,
				attr: TAG_ATTR,
				tag,
				timeoutMs,
			}),
			timeoutMs,
		);
		if (!res.found) return { disabled: !!res.disabled };
		return { selector: `[${TAG_ATTR}="${tag}"]`, tag };
	}

	async click(target: string, timeoutMs = this.timeoutMs): Promise<void> {
		const hit = await this.resolve(target, "click", timeoutMs);
		if (!("selector" in hit)) {
			throw new Error(
				hit.disabled
					? `click target "${target}" is disabled`
					: `click target "${target}" not found (role/label/placeholder/text/css)`,
			);
		}
		try {
			await this.bsk(["click", hit.selector, "--timeout", `${Math.max(timeoutMs, 1000)}ms`]);
		} finally {
			// The click may have navigated away; removing the tag is best effort.
			await this.untag(TAG_ATTR);
		}
	}

	async fill(target: string, value: string, timeoutMs = this.timeoutMs): Promise<string | undefined> {
		const hit = await this.resolve(target, "fill", timeoutMs);
		if ("selector" in hit) {
			try {
				await this.bsk(["fill", hit.selector, "--value", value, "--timeout", `${Math.max(timeoutMs, 1000)}ms`]);
				const form = await this.readForm(false, TAG_ATTR);
				return form.landed;
			} finally {
				await this.untag(TAG_ATTR);
			}
		}
		// Grounded fallback, as in BrowserPage.fillByProximity: the same names the snapshot keys by.
		const form = await this.readForm(true, TAG_ATTR);
		try {
			const stripped = withoutUiNoun(target, { phrases: this.phrases });
			const field =
				bestFieldMatch(target, form.writable) ?? (stripped ? bestFieldMatch(stripped, form.writable) : null);
			if (!field) throw new Error(`fill target "${target}" not found (label/placeholder/name/id/title/css)`);
			await this.bsk([
				"fill",
				`[data-osteron-field="${field.index}"]`,
				"--value",
				value,
				"--timeout",
				`${Math.max(timeoutMs, 1000)}ms`,
			]);
			return field.key;
		} finally {
			await this.untag("data-osteron-field");
		}
	}

	private async readForm(mark: boolean, landedAttr: string): Promise<FormRead> {
		return await this.evaluate<FormRead>(call(readFormInPage, { mark, fillable: FILLABLE_CSS, landedAttr }));
	}

	async snapshot(opts: { screenshot?: boolean } = {}): Promise<PageSnapshot> {
		const arg = { mark: false, fillable: FILLABLE_CSS, landedAttr: TAG_ATTR };
		const state = await this.evaluate<
			FormRead & {
				url: string;
				text: string;
				html: string;
			}
		>(
			`(()=>{const readForm=${readFormInPage.toString()};const f=readForm(${JSON.stringify(arg)});return {url:location.href,text:document.body?document.body.innerText:"",html:document.documentElement.outerHTML,fields:f.fields,controls:f.controls,limits:f.limits,clickables:f.clickables}})()`,
		);
		const screenshot = this.screenshotEnabled && opts.screenshot !== false ? await this.screenshot() : undefined;
		return {
			url: state.url,
			text: state.text,
			html: state.html,
			fields: state.fields,
			controls: state.controls,
			fieldLimits: state.limits,
			clickables: state.clickables,
			screenshot,
		};
	}

	/** Viewport PNG as a data URL; undefined when capture fails (evidence is best effort). */
	private async screenshot(): Promise<string | undefined> {
		const out = join(tmpdir(), `bsk-page-${randomUUID()}.png`);
		try {
			await this.bsk(["screenshot", "--out", out]);
			return `data:image/png;base64,${(await readFile(out)).toString("base64")}`;
		} catch {
			return undefined;
		} finally {
			await rm(out, { force: true }).catch(() => {});
		}
	}

	// resetSession() is intentionally absent: it would clear cookies and web storage in the user's real,
	// logged-in browser profile. See the file header.

	/** Stop the bsk session. Always issues `session stop`, even if earlier commands failed; idempotent. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const res = await this.run(["session", "stop", this.sessionId, "--json"]);
		if (res.code !== 0) throw new Error(`bsk session stop failed — ${failureReason(res)}`);
	}
}
