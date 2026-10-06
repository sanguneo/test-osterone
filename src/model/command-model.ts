/**
 * A model behind any command-line agent in print mode — `omo -p`, `claude -p`, `codex exec` and the like.
 *
 * The conversation goes in on stdin as plain text and the reply comes back on stdout, so whatever model
 * and login the user already runs that agent with becomes test-osterone's authoring model, without an API
 * key. Text only: an image part is refused rather than silently dropped, because a caller that needed the
 * screenshot (vision) must not get an answer that never looked at it.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
	type CompleteOptions,
	DEFAULT_REQUEST_TIMEOUT_MS,
	type ModelClient,
	type ModelMessage,
} from "./model-client.ts";

export function parseCommand(text: string): string[] {
	const argv: string[] = [];
	for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) argv.push(match[1] ?? match[2] ?? match[3] ?? "");
	return argv;
}

export function renderConversation(messages: readonly ModelMessage[]): string {
	return messages
		.map((message) => {
			if (typeof message.content !== "string" && message.content.some((part) => part.type === "image")) {
				throw new Error("a command-line model cannot take images; connect an API model for vision");
			}
			const text =
				typeof message.content === "string"
					? message.content
					: message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
			return `[${message.role}]\n${text}`;
		})
		.join("\n\n");
}

/**
 * Find a bare command on PATH the way a shell would, including Windows' PATHEXT shims. Node's own lookup
 * gives up on a PATH that carries a stray quote (measured on this machine), and a shell would re-parse
 * every argument; resolving here lets the agent run with its argv untouched.
 */
export function resolveExecutable(bin: string, env: NodeJS.ProcessEnv = process.env): string {
	if (bin.includes("/") || bin.includes("\\")) return bin;
	const exts = process.platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
	for (const raw of (env.PATH ?? env.Path ?? "").split(delimiter)) {
		const dir = raw.replace(/"/g, "").trim();
		if (!dir) continue;
		for (const ext of exts) {
			const candidate = join(dir, bin + ext);
			if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
		}
	}
	return bin;
}

export class CommandModelClient implements ModelClient {
	private readonly argv: string[];

	constructor(command: string | string[]) {
		this.argv = typeof command === "string" ? parseCommand(command) : [...command];
		if (this.argv.length === 0) throw new Error("empty model command");
	}

	complete(messages: ModelMessage[], opts: CompleteOptions = {}): Promise<string> {
		const prompt = renderConversation(messages);
		const [bin, ...args] = this.argv as [string, ...string[]];
		return new Promise((resolve, reject) => {
			// Only a .cmd/.bat shim needs cmd.exe, and then every argument is quoted for it. The prompt never
			// touches the command line: it goes in on stdin, so nothing a QC sheet says is ever shell-parsed.
			const exe = resolveExecutable(bin);
			const viaCmd = /\.(cmd|bat)$/i.test(exe);
			const quote = (arg: string) => `"${arg.replace(/"/g, '""')}"`;
			const child = viaCmd
				? spawn(quote(exe), args.map(quote), { shell: true, windowsHide: true })
				: spawn(exe, args, { windowsHide: true });
			let stdout = "";
			let stderr = "";
			const timer = setTimeout(() => {
				child.kill();
				reject(new Error(`model command timed out after ${opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS} ms`));
			}, opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
			child.stdout.on("data", (chunk) => {
				stdout += String(chunk);
			});
			child.stderr.on("data", (chunk) => {
				stderr += String(chunk);
			});
			child.on("error", (error) => {
				clearTimeout(timer);
				reject(new Error(`model command failed to start: ${error.message}`));
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				if (code === 0 && stdout.trim()) resolve(stdout.trim());
				else reject(new Error(`model command exited ${code}: ${(stderr || stdout).trim().slice(-400)}`));
			});
			child.stdin.end(prompt);
		});
	}
}
