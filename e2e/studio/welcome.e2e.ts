import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("the Studio opens on its project list with a way to start one", async ({ app, screen }) => {
	await app.open("/");
	await expect(screen.getByRole("heading", /^(프로젝트|Projects)$/)).toBeVisible();
	await expect(screen.getByRole("button", /(새 프로젝트|New Project)/)).toBeVisible();
});
