import { expect, test } from "bun:test";

import {
	bestFieldMatch,
	browserInstallHint,
	type FieldEntry,
	flexTextRe,
	looksLikeCss,
	withoutUiNoun,
} from "../src/execute/browser-page.ts";

/** The account editor as the page actually describes itself: a visible row label, an instructional placeholder. */
const EDITOR: FieldEntry[] = [
	{ index: 0, key: "기관명", names: ["기관명"] },
	{ index: 1, key: "이메일", names: ["이메일", "이메일을 입력해 주세요.", "email"] },
	{ index: 2, key: "연락처", names: ["연락처", "'-' 를 제외한 번호를 입력해 주세요.", "contact"] },
];

test("bestFieldMatch resolves the sheet's word for a box the app labels with instructions", () => {
	// Measured: three cases typed into "연락처" and every candidate missed, because the app's own label
	// sits a level above the input and the placeholder shares no character with the word the sheet uses.
	expect(bestFieldMatch("연락처", EDITOR)?.index).toBe(2);
	expect(bestFieldMatch("이메일", EDITOR)?.index).toBe(1);
	// The app's own wording resolves to the same field — that is the point of carrying every alias.
	expect(bestFieldMatch("이메일을 입력해주세요", EDITOR)?.index).toBe(1);
	expect(bestFieldMatch("contact", EDITOR)?.index).toBe(2);
});

test("bestFieldMatch refuses what it cannot pin to one box", () => {
	// A target no field answers to fails, rather than settling for the nearest thing: a fill that lands
	// somewhere else leaves the case checking a box it never typed into.
	expect(bestFieldMatch("비밀번호", EDITOR)).toBeNull();
	// Too short to anchor — "no" would match half the placeholders on any page.
	expect(bestFieldMatch("x", EDITOR)).toBeNull();
	expect(bestFieldMatch("연락처", [])).toBeNull();
	// The shortest matching name wins: the row label, not the sentence that happens to contain it.
	const noisy: FieldEntry[] = [
		{ index: 0, key: "이메일 인증번호", names: ["이메일 인증번호"] },
		{ index: 1, key: "이메일", names: ["이메일"] },
	];
	expect(bestFieldMatch("이메일", noisy)?.index).toBe(1);
});

test("browserInstallHint: maps Playwright's missing-executable error to an actionable install hint", () => {
	const pwError = [
		"browserType.launch: Executable doesn't exist at C:\\Users\\me\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win\\chrome.exe",
		"╔══════════════════════════════════════════════════════════╗",
		"║ Looks like Playwright Test or Playwright was just installed ║",
		"║ or updated. Please run the following command to download   ║",
		"║ new browsers:  npx playwright install                      ║",
		"╚══════════════════════════════════════════════════════════╝",
	].join("\n");
	const hint = browserInstallHint(pwError);
	expect(hint).not.toBeNull();
	expect(hint).toContain("playwright install chromium");
});

test("browserInstallHint: maps a missing `playwright` package to a package-install hint", () => {
	// Reachable now that playwright is imported on demand: Studio boots without it, and only a run
	// that actually needs a browser hits the module-resolution failure.
	const hint = browserInstallHint("Cannot find package 'playwright' imported from /app/src/execute/browser-page.ts");
	expect(hint).toContain("bun install");
	expect(browserInstallHint("Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'playwright'")).toContain("bun install");
});

test("withoutUiNoun bridges the sheet's wording and the app's placeholder", () => {
	// Measured: six fills failed on fields that were right there. A sheet names a box "이메일 입력란";
	// the app's only accessible name is its placeholder, "이메일을 입력해주세요." — neither string is a
	// substring of the other, so every candidate missed. Stripping the noun leaves what they share.
	expect(withoutUiNoun("이메일 입력란")).toBe("이메일");
	expect(withoutUiNoun("비고란")).toBe("비고");
	expect(withoutUiNoun("Save button")).toBe("Save");
	// A region named as if it were a control: the app paints `<label>발송그룹</label>` and the list under
	// it, and there is no "발송 그룹 필터" anywhere — the four cases that start with this step all abort.
	expect(withoutUiNoun("발송 그룹 필터")).toBe("발송 그룹");
	expect(withoutUiNoun("Group filter")).toBe("Group");
	// Nothing to strip, or nothing left worth locating by → null, so no extra candidate is added.
	expect(withoutUiNoun("기관명")).toBeNull();
	expect(withoutUiNoun("입력란")).toBeNull();
	expect(withoutUiNoun("버튼")).toBeNull();
});

test("importing the browser adapter does not load playwright", () => {
	// The engine's non-browser surface (sheet ingest, rule interpretation, verdict evaluation, this
	// file's own helpers) must not pay for — or require — playwright. Only `chromium.launch` needs
	// the real module, so it is imported on demand. A subprocess is used because this test file has
	// already imported the adapter by the time the body runs.
	const target = new URL("../src/execute/browser-page.ts", import.meta.url).href;
	const probe = [
		'import { createRequire } from "node:module";',
		`const req = createRequire(${JSON.stringify(target)});`,
		`await import(${JSON.stringify(target)});`,
		'console.log(Object.keys(req.cache ?? {}).filter((k) => k.includes("playwright")).length);',
	].join("\n");
	const res = Bun.spawnSync([process.execPath, "-e", probe]);
	expect(res.stderr.toString()).toBe("");
	// A static `import ... from "playwright"` puts 8 entries in the cache here; on demand puts 0.
	expect(res.stdout.toString().trim()).toBe("0");
});

test("browserInstallHint: returns null for unrelated launch/runtime errors", () => {
	expect(browserInstallHint("net::ERR_CONNECTION_REFUSED at http://localhost:9999")).toBeNull();
	expect(browserInstallHint("Timeout 5000ms exceeded")).toBeNull();
	expect(browserInstallHint("")).toBeNull();
});

test("flexTextRe matches live label copy that only differs from the target by spacing", () => {
	const re = flexTextRe("아이디를 입력해주세요");
	expect(re).not.toBeNull();
	// The real app renders "아이디를 입력해 주세요." — extra space, trailing period.
	expect(re?.test("아이디를 입력해 주세요.")).toBe(true);
	expect(re?.test("아이디를입력해주세요")).toBe(true);
	expect(re?.test("비밀번호를 입력해 주세요.")).toBe(false);
	expect(flexTextRe("전체 결재문서")?.test("전체결재문서")).toBe(true);
});

test("flexTextRe refuses targets too short to anchor and escapes regex metacharacters", () => {
	expect(flexTextRe("A")).toBeNull();
	expect(flexTextRe(" ")).toBeNull();
	expect(flexTextRe("a+b")?.test("a+b")).toBe(true);
	expect(flexTextRe("a+b")?.test("aab")).toBe(false);
});

test("looksLikeCss: only real selectors reach the CSS engine, never a human label", () => {
	expect(looksLikeCss("#loginId")).toBe(true);
	expect(looksLikeCss(".btn-primary")).toBe(true);
	expect(looksLikeCss('[data-test="save"]')).toBe(true);
	expect(looksLikeCss("button")).toBe(true);
	// A label with CSS metacharacters used to throw a *selector parse* error at action time, which
	// killed the whole role/text locator chain instead of simply not matching.
	expect(looksLikeCss("아이디/비밀번호 찾기")).toBe(false);
	expect(looksLikeCss("개인정보처리방침")).toBe(false);
	expect(looksLikeCss("Save changes")).toBe(false);
	expect(looksLikeCss("")).toBe(false);
});
