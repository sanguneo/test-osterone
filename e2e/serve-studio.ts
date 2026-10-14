/**
 * Boots the real Studio for the e2e suite on the port the runner allocated.
 *
 * Studio keeps projects, runs and a remembered model login under the user's home directory, so the
 * suite runs it against a throwaway home: no developer's projects leak into a test, and no Codex login
 * is auto-restored — every run interprets by rule, the deterministic path. The home is wiped at start
 * rather than at exit because the runner stops this process without running exit hooks.
 *
 *   node --experimental-strip-types e2e/serve-studio.ts <port>
 */
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.argv[2] ?? process.env.PORT ?? "0";
// One home per port: two suites running at once (two checkouts, or a suite beside `bun run qa:bsk`)
// must not wipe each other's state. Homes left by earlier runs are swept once they are stale.
const homes = join(repo, ".e2e", "studio-home");
const home = join(homes, port);
mkdirSync(homes, { recursive: true });
for (const entry of readdirSync(homes)) {
	const dir = join(homes, entry);
	if (dir === home || Date.now() - statSync(dir).mtimeMs > 6 * 3_600_000) rmSync(dir, { recursive: true, force: true });
}
mkdirSync(home, { recursive: true });

process.env.PORT = port;
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CODEX_HOME = join(home, ".codex");

await import("../src/app/studio/server.ts");
