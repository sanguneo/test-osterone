/**
 * One-off probe: does a fill target reach the box the sheet names, and can the check find it afterwards?
 *
 * The account editor puts `<label class="form-label">연락처</label>` in `div.form-item` while the input
 * itself lives in `div.form-input-wrap` — so the label is one level above anything the field candidates
 * looked at, and the placeholder ("'-' 를 제외한 번호를 입력해 주세요.") shares no character with the
 * word the sheet uses. Three cases timed out typing into a box that was on screen, and a fourth typed
 * successfully and then failed with `field "이메일" not on screen`, because the fill and the check
 * resolved the field by two different rules.
 *
 * Runs the shipped adapter: prints the snapshot's field keys (what a `fieldAtMost`/`fieldExcludes` check
 * can look up), then fills each target and reports whether the check would find that same field.
 *
 * Usage: node --experimental-transform-types scripts/probe-form-labels.ts <baseUrl> <user> <pass>
 */
import { BrowserPage } from "../src/execute/browser-page.ts";

const [baseUrl, user, pass, listPath = "/account"] = process.argv.slice(2);
if (!baseUrl || !user || !pass) {
	console.error("usage: probe-form-labels.ts <baseUrl> <user> <pass> [listPath]");
	process.exit(2);
}

const page = await BrowserPage.create({ baseUrl, headless: true, timeoutMs: 4000 });
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

await page.goto("/");
await page.fill("아이디", user);
await page.fill("비밀번호", pass);
await page.click("로그인");
await settle(2500);
await page.goto(listPath);
await settle(1800);
await page.clickRow(1);
await settle(1800);

console.log("=== snapshot().fields keys — the only names a field check can look up");
for (const [k, v] of Object.entries((await page.snapshot({ screenshot: false })).fields ?? {})) {
	console.log(`  "${k}" = ${JSON.stringify(v).slice(0, 46)}`);
}

for (const [target, value] of [
	["연락처", "abc"],
	["이메일", "not-an-email"],
]) {
	let error = "";
	try {
		await page.fill(target ?? "", value ?? "");
	} catch (err) {
		error = ` — THREW: ${String((err as Error).message ?? err).split("\n")[0]}`;
	}
	const fields = (await page.snapshot({ screenshot: false })).fields ?? {};
	const found = Object.entries(fields).find(([k]) => k.replace(/\s+/g, "") === (target ?? "").replace(/\s+/g, ""));
	console.log(
		`\nfill "${target}"${error}\n  a check for "${target}" → ${found ? `resolves, value=${JSON.stringify(found[1])}` : "NOT ON SCREEN — this is the hold"}`,
	);
}

await page.close();
