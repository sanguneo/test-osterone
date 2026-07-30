/**
 * One-off probe: does a click on a *styled* radio reach the control the sheet names?
 *
 * The account editor paints its 상태 radios as `<span class="r_circle">` inside a `<label>` and keeps
 * the real `<input type="radio">` at `opacity: 0`. The input carries the accessible name, so every
 * name-based candidate resolves to it and then Playwright refuses to click something invisible — the
 * two cases that select 활성/비활성 died on a control that was on screen the whole time.
 *
 * Runs the shipped adapter (not a re-implementation of its ranking) through exactly what the two cases
 * do — open the list, select a row, click the named radio — and reports `snapshot().controls`, the same
 * map the `controlSelected` check reads, before and after. A state that does not flip is a click that
 * answered for something else; a label that is not in the map is a check that can never pass.
 *
 * Usage: node --experimental-transform-types scripts/probe-radio-control.ts <baseUrl> <user> <pass>
 */
import { BrowserPage } from "../src/execute/browser-page.ts";

const [baseUrl, user, pass, listPath = "/account"] = process.argv.slice(2);
if (!baseUrl || !user || !pass) {
	console.error("usage: probe-radio-control.ts <baseUrl> <user> <pass> [listPath]");
	process.exit(2);
}

const page = await BrowserPage.create({ baseUrl, headless: true, timeoutMs: 5000 });

/** The map the `controlSelected` check reads — the only thing that says the right control answered. */
const state = async (): Promise<Record<string, boolean>> => (await page.snapshot({ screenshot: false })).controls ?? {};
const show = (s: Record<string, boolean>): string =>
	Object.entries(s)
		.map(([k, v]) => `${k}=${v}`)
		.join(" ") || "(no radios)";

await page.goto("/");
await page.fill("아이디", user);
await page.fill("비밀번호", pass);
await page.click("로그인");
await new Promise((r) => setTimeout(r, 2500));

// Each target is clicked *from the opposite state*, so "it is selected afterwards" cannot be true by
// accident: 활성 is the app's default, and a click that never landed would look identical to a pass.
for (const [opposite, target] of [
	["활성", "비활성"],
	["비활성", "활성"],
]) {
	await page.goto(listPath);
	await new Promise((r) => setTimeout(r, 1500));
	await page.clickRow(1);
	await new Promise((r) => setTimeout(r, 1500));
	await page.click(opposite).catch(() => {});
	const before = await state();
	let error = "";
	const started = Date.now();
	try {
		await page.click(target);
	} catch (err) {
		error = ` — click threw: ${String((err as Error).message ?? err).split("\n")[0]}`;
	}
	const after = await state();
	const ok = before[target] === false && after[target] === true;
	console.log(
		`click "${target}" in ${Date.now() - started}ms${error}\n  before ${show(before)}\n  after  ${show(after)}\n  ${ok ? "OK — the named control is now selected" : "MISS — the click did not reach this control"}`,
	);
}

await page.close();
