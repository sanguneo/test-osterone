/**
 * One-off probe: is a popup's close control findable *structurally*, without a per-app convention list?
 *
 * A sheet says "X 버튼 선택" and `X` is no accessible name — the close affordance is an icon. Enumerating
 * conventions (aria-label, class, svg, `<dialog>`, div modal) is a losing game, so the question is
 * whether geometry answers it instead: the nameless clickable nearest the top-right of whatever
 * container is currently modal.
 *
 * Prints what it finds rather than acting on it. Pressing Escape is deliberately not considered: a case
 * that tests "the X button closes the popup" would pass without the X button ever being touched.
 *
 * Run: node scripts/probe-modal-close.mjs <baseUrl> <user> <pass> <listPath>
 */
import { chromium } from "playwright";

const [baseUrl, user, pass, listPath = "/account"] = process.argv.slice(2);
if (!baseUrl || !user || !pass) {
	console.error("usage: probe-modal-close.mjs <baseUrl> <user> <pass> [listPath]");
	process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const url = (p) => new URL(p, baseUrl).toString();

await page.goto(url("/"), { waitUntil: "domcontentloaded" });
// Log in the way any app allows: fill the two obvious fields and submit.
await page.getByLabel(/아이디|username|id/i).or(page.getByPlaceholder(/아이디|username/i)).first().fill(user);
await page.getByLabel(/비밀번호|password/i).or(page.getByPlaceholder(/비밀번호|password/i)).first().fill(pass);
await page.getByRole("button", { name: /로그인|log ?in|sign ?in/i }).first().click();
await page.waitForTimeout(2500);

await page.goto(url(listPath), { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
await page.locator("table tbody tr").first().click();
await page.waitForTimeout(1500);

const found = await page.evaluate(() => {
	const vw = innerWidth;
	const vh = innerHeight;
	// Whatever is modal right now: a real dialog, an ARIA dialog, or the largest fixed/absolute overlay.
	const explicit = Array.from(document.querySelectorAll("dialog[open], [role=dialog], [aria-modal=true]")).filter(
		(el) => el.getBoundingClientRect().width > 0,
	);
	const overlays = Array.from(document.querySelectorAll("div, section, aside")).filter((el) => {
		const s = getComputedStyle(el);
		if (s.position !== "fixed" && s.position !== "absolute") return false;
		const r = el.getBoundingClientRect();
		return r.width > vw * 0.25 && r.height > vh * 0.25 && r.width < vw * 0.98;
	});
	const modal = explicit[0] ?? overlays.sort((a, b) => Number(getComputedStyle(b).zIndex || 0) - Number(getComputedStyle(a).zIndex || 0))[0];
	// This app has no modal: its "popup" is an inline panel on the same URL. Fall back to the whole
	// document so the probe still answers whether a nameless close affordance exists anywhere.
	const scope = modal ?? document.body;
	const box = scope.getBoundingClientRect();
	const clickables = Array.from(scope.querySelectorAll("button, [role=button], a, svg, i, span[class]"))
		.map((el) => {
			const r = el.getBoundingClientRect();
			return {
				tag: el.tagName.toLowerCase(),
				text: (el.textContent ?? "").trim().slice(0, 12),
				aria: el.getAttribute("aria-label") ?? "",
				cls: String(el.className?.baseVal ?? el.className ?? "").slice(0, 32),
				w: Math.round(r.width),
				h: Math.round(r.height),
				dx: Math.round(box.right - r.right),
				dy: Math.round(r.top - box.top),
			};
		})
		.filter((c) => c.w > 6 && c.h > 6 && c.w < 80 && c.h < 80)
		.filter((c) => c.text.length <= 2)
		.sort((a, b) => a.dx + a.dy - (b.dx + b.dy));
	return {
		modal: modal ? { tag: modal.tagName.toLowerCase(), role: modal.getAttribute("role") ?? "" } : "none — inline panel",
		explicitCount: explicit.length,
		candidates: clickables.slice(0, 6),
	};
});

console.log(JSON.stringify(found, null, 1));
await browser.close();
