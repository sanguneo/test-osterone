import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { resolveCliModel } from "../src/model/cli-model.ts";
import { CommandModelClient, parseCommand, renderConversation, resolveExecutable } from "../src/model/command-model.ts";

test("a bare agent name is found on PATH even behind an entry with a stray quote", () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-path-"));
	try {
		const file = join(dir, process.platform === "win32" ? "agent.exe" : "agent");
		writeFileSync(file, "");
		const env = { PATH: [`${join(dir, "missing")}"`, dir].join(delimiter), PATHEXT: ".EXE" };
		expect(resolveExecutable("agent", env).toLowerCase()).toBe(file.toLowerCase());
		expect(resolveExecutable("not-installed", env)).toBe("not-installed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

const ECHO_STDIN_AGENT = [
	process.execPath,
	"-e",
	"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write('GOT\\n'+s))",
];

test("the conversation reaches the agent on stdin, system text first, and its stdout is the reply", async () => {
	const reply = await new CommandModelClient(ECHO_STDIN_AGENT).complete([
		{ role: "system", content: "Answer in JSON." },
		{ role: "user", content: [{ type: "text", text: "Rewrite: click the login button" }] },
	]);
	expect(reply).toBe("GOT\n[system]\nAnswer in JSON.\n\n[user]\nRewrite: click the login button");
});

test("a failing agent is an error with its own message, never an empty answer", async () => {
	const failing = new CommandModelClient([process.execPath, "-e", "console.error('quota exhausted'); process.exit(3)"]);
	await expect(failing.complete([{ role: "user", content: "hi" }])).rejects.toThrow(/exited 3: quota exhausted/);
	const silent = new CommandModelClient([process.execPath, "-e", "process.exit(0)"]);
	await expect(silent.complete([{ role: "user", content: "hi" }])).rejects.toThrow(/exited 0/);
});

test("an image is refused instead of being dropped from what the model sees", () => {
	expect(() =>
		renderConversation([{ role: "user", content: [{ type: "image", imageUrl: "data:image/png;base64,AA" }] }]),
	).toThrow(/cannot take images/);
});

test("a command line splits into argv with quoted arguments kept whole", () => {
	expect(parseCommand(`omo -p --model "anthropic/claude x" --no-tools`)).toEqual([
		"omo",
		"-p",
		"--model",
		"anthropic/claude x",
		"--no-tools",
	]);
});

test("an API key still wins over a model command, and the command wins over a Codex login", () => {
	expect(resolveCliModel({ OPENAI_API_KEY: "sk-x", TEST_OSTERONE_MODEL_COMMAND: "omo -p" })?.label).toMatch(/^api-key/);
	expect(resolveCliModel({ TEST_OSTERONE_MODEL_COMMAND: "omo -p --no-tools" })?.label).toBe(
		"command · omo -p --no-tools",
	);
});
