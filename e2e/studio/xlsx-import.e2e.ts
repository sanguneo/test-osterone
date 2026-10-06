import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { startFixture } from "../../src/testing/fixture-app.ts";

/**
 * A QC workbook goes in through the Studio's own upload, and the verdicts come out of a real run.
 *
 * qc-cases.xlsx carries a cover tab (표지) beside the case tab (로그인). The picker must leave the cover
 * unselected, the imported sheet must hold exactly the four cases of 로그인, and the rule engine must
 * judge them against the fixture login app the way the sheet's expectations demand — including the
 * failing case (TC3) and the one it cannot prove (TC4), which has to land in review, never as a pass.
 */
const EXPECTED = [
	{ title: "Valid login shows welcome", verdict: "통과" },
	{ title: "Invalid login shows error", verdict: "통과" },
	{ title: "Wrong password must not pass as welcome", verdict: "실패" },
	{ title: "Missing button triggers self-heal gate", verdict: "리뷰 필요" },
] as const;

test("an XLSX QC workbook imports through the UI and runs to the expected verdicts", { timeout: 240_000 }, async ({
	app,
	screen,
}) => {
	const fixture = await startFixture();
	try {
		await app.open("/");

		// Create the project through its form, aimed at the fixture app.
		await screen.getByRole("button", "새 프로젝트").tap();
		const projectDialog = screen.getByRole("dialog", "프로젝트");
		await projectDialog.getByLabel("이름").fill("XLSX import");
		await projectDialog.getByPlaceholder("https://your.app").fill(fixture.url);
		await projectDialog.getByRole("button", "저장").tap();
		await expect(screen.getByRole("heading", "XLSX import")).toBeVisible();

		// Add the sheet by uploading the workbook.
		await screen.getByRole("button", "새 시트").tap();
		const sheetDialog = screen.getByRole("dialog", "시트");
		await sheetDialog.getByRole("button", "XLSX").tap();
		await sheetDialog.getByLabel("XLSX 파일 선택").setInputFiles("e2e/fixtures/qc-cases.xlsx");

		// The cover tab is recognised as not-a-TC and left out; only 로그인 is picked.
		await expect(sheetDialog.getByText(/qc-cases\.xlsx/)).toBeVisible();
		await expect(sheetDialog.getByRole("checkbox", /로그인/)).toBeChecked();
		await expect(sheetDialog.getByRole("checkbox", /표지/)).toBeChecked({ checked: false });
		await sheetDialog.getByRole("button", "선택 1개 가져오기").tap();
		await expect(screen.getByRole("dialog", "시트")).toBeHidden();

		// The import lands as one sheet named after the file, and the Studio opens it: the sheet's view rail
		// is there without another tap (it once fell back to the project home before the save returned).
		const rail = screen.getByRole("navigation", "시트 보기");
		await expect(rail).toBeVisible({ timeout: 15_000 });

		// The run bench previews exactly the four cases of 로그인 — nothing from the cover.
		await rail.getByRole("button", "실행 작업대").tap();
		const previewRows = screen.getByRole("row", { visible: true });
		await expect(previewRows).toHaveCount(1 + 4);
		for (const { title } of EXPECTED) {
			await expect(previewRows.filter({ hasText: title })).toHaveCount(1);
		}
		await expect(previewRows.filter({ hasText: "표지" })).toHaveCount(0);

		// Run it, then read the verdicts where the finished run lives.
		await screen.getByRole("button", "실행 시작").tap();
		// Wait for the run to end either way, so a run that errors out fails here with its own message
		// instead of as a three-minute timeout.
		const finished = screen.getByText(/^(실행 완료|오류: .*)$/, { visible: true });
		await expect(finished).toBeVisible({ timeout: 180_000 });
		const runError = screen.getByRole("alert", { visible: true });
		if ((await runError.count()) > 0) throw new Error(`the run failed: ${await runError.first().textContent()}`);
		await expect(screen.getByText("실행 완료", { visible: true })).toBeVisible();
		await screen.getByRole("button", "실행 현황에서 보기 →").tap();

		const resultRows = screen.getByRole("row", { visible: true });
		await expect(resultRows).toHaveCount(1 + 4);
		for (const { title, verdict } of EXPECTED) {
			const row = resultRows.filter({ hasText: title });
			await expect(row.getByRole("cell").nth(1)).toHaveText(verdict);
		}
		await expect(screen.getByRole("button", "통과 2")).toBeVisible();
		await expect(screen.getByRole("button", "실패 1")).toBeVisible();
		await expect(screen.getByRole("button", "리뷰 필요 1")).toBeVisible();
		await expect(screen.getByRole("button", "오류 0")).toBeVisible();
	} finally {
		fixture.stop();
	}
});
