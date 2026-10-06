import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("the KO/EN toggle switches the visible copy and the choice survives a reload", async ({
	app,
	screen,
	browser,
}) => {
	await app.open("/");
	const korean = async () => {
		await expect(screen.getByRole("heading", "프로젝트")).toBeVisible();
		await expect(screen.getByRole("button", "새 프로젝트")).toBeVisible();
		await expect(screen.getByRole("heading", "Projects")).toBeHidden();
	};
	const english = async () => {
		await expect(screen.getByRole("heading", "Projects")).toBeVisible();
		await expect(screen.getByRole("button", "New Project")).toBeVisible();
		await expect(screen.getByRole("heading", "프로젝트")).toBeHidden();
	};

	// A fresh browser has no stored choice: the Studio starts in Korean.
	await korean();

	await screen.getByRole("button", "EN").tap();
	await english();
	await browser.reload();
	await english();

	await screen.getByRole("button", "한글").tap();
	await korean();
	await browser.reload();
	await korean();
});
