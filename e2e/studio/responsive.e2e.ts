import { test } from "@e2e-dev/web";
import { expect } from "e2e";

/**
 * The sheet view rail is a left vertical rail on desktop and a bottom dock on a phone (README).
 *
 * Both tests run on every web target; `platforms` cannot tell viewports apart (all are `web`), so each
 * skips itself on the other size, the way docs/viewports.mdx prescribes. A project with one CSV sheet
 * is seeded over the API — the precondition — and the layout is then read from the rendered page.
 */
const VIEWS = ["실행 현황", "규칙·해석", "실행 작업대", /^리뷰 대기/] as const;
const PHONE_MAX_WIDTH = 600; // the breakpoint in styles/responsive.css that turns the rail into a dock

async function openSeededSheet(baseUrl: string | undefined, open: (path: string) => Promise<void>): Promise<void> {
	if (!baseUrl) throw new Error("the Studio target declares no app.url");
	const id = `responsive-${Date.now()}`;
	const response = await fetch(new URL("/api/projects", baseUrl), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			id,
			name: "Responsive",
			sheets: [
				{
					id: "sheet",
					name: "Login",
					kind: "csv",
					sheetUrl: "",
					csvText: 'Title,Steps,Expected\nSign in,open /,"Sign in"',
				},
			],
		}),
	});
	if (response.status !== 200)
		throw new Error(`seeding the project failed: ${response.status} ${await response.text()}`);
	await open(`/p/${id}/sheet`);
}

test("on a phone the sheet view rail is a bottom dock and nothing overflows sideways", async ({
	app,
	screen,
	browser,
}) => {
	await openSeededSheet(app.baseUrl, (path) => app.open(path));
	const viewport = await browser.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
	test.skip(viewport.width > PHONE_MAX_WIDTH, "phone layout only");

	const rail = screen.getByRole("navigation", "시트 보기");
	await expect(rail).toBeVisible();
	for (const name of VIEWS) await expect(rail.getByRole("button", name)).toBeVisible();

	const box = await rail.boundingBox();
	expect(box).not.toBeNull();
	if (!box) return;
	// Docked along the bottom edge, spanning the width, wider than tall.
	expect(box.y + box.height).toBeGreaterThan(viewport.height - 40);
	expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
	expect(box.width).toBeGreaterThan(viewport.width * 0.8);
	expect(box.width).toBeGreaterThan(box.height);
	// The four views sit side by side in one row.
	const tops = await Promise.all(
		VIEWS.map(async (name) => (await rail.getByRole("button", name).boundingBox())?.y ?? Number.NaN),
	);
	for (const top of tops) expect(Math.abs(top - (tops[0] ?? Number.NaN))).toBeLessThan(2);

	const overflow = await browser.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth,
	}));
	expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
});

test("on desktop the sheet view rail is a vertical rail on the left", async ({ app, screen, browser }) => {
	await openSeededSheet(app.baseUrl, (path) => app.open(path));
	const viewport = await browser.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
	test.skip(viewport.width <= PHONE_MAX_WIDTH, "desktop layout only");

	const rail = screen.getByRole("navigation", "시트 보기");
	await expect(rail).toBeVisible();
	for (const name of VIEWS) await expect(rail.getByRole("button", name)).toBeVisible();

	const box = await rail.boundingBox();
	expect(box).not.toBeNull();
	if (!box) return;
	// Hugging the left edge, taller than wide.
	expect(box.x).toBeLessThan(2);
	expect(box.height).toBeGreaterThan(box.width);
	expect(box.width).toBeLessThan(viewport.width / 4);
	// The four views stack top to bottom in one column.
	const boxes = await Promise.all(VIEWS.map((name) => rail.getByRole("button", name).boundingBox()));
	for (let i = 1; i < boxes.length; i++) {
		const previous = boxes[i - 1];
		const current = boxes[i];
		expect(previous && current && current.y > previous.y && Math.abs(current.x - previous.x) < 2).toBe(true);
	}
});
