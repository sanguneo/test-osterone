import { expect, test } from "bun:test";
import { extractStructure } from "../src/interpret/recon.ts";
import { groundAction, pregroundAction, repairAction } from "../src/interpret/repair.ts";
import { FakeModelClient, type ModelMessage } from "../src/model/model-client.ts";

/** A live screen whose labels drifted from the authored plan ("저장" is now "저장하기"). */
const LIVE_HTML = `<!doctype html><html><head><title>결재 상세</title></head><body>
	<nav><a href="/approvals">결재함</a><a href="/settings">환경 설정</a></nav>
	<h1>결재 상세</h1>
	<input name="comment" placeholder="의견을 입력해 주세요." />
	<button>저장하기</button>
	<button>취소</button>
</body></html>`;

const SCAN = extractStructure(LIVE_HTML, "/approvals/1");

test("groundAction snaps a proposal onto the label the page actually renders", () => {
	expect(groundAction({ kind: "click", target: "저장" }, SCAN)).toEqual({ kind: "click", target: "저장하기" });
	expect(groundAction({ kind: "fill", target: "의견", value: "확인함" }, SCAN)).toEqual({
		kind: "fill",
		target: "의견을 입력해 주세요.",
		value: "확인함",
	});
	expect(groundAction({ kind: "goto", path: "/settings" }, SCAN)).toEqual({ kind: "goto", path: "/settings" });
});

test("groundAction rejects anything the live page does not expose (no invented targets)", () => {
	expect(groundAction({ kind: "click", target: "결재 반려" }, SCAN)).toBeNull();
	expect(groundAction({ kind: "fill", target: "비밀번호", value: "x" }, SCAN)).toBeNull();
	// a route the page never links to — the model may not invent navigation
	expect(groundAction({ kind: "goto", path: "/admin/secret" }, SCAN)).toBeNull();
	expect(groundAction({ kind: "goto", path: "https://evil.example.com" }, SCAN)).toBeNull();
	expect(groundAction({ kind: "unknown", text: "무언가" }, SCAN)).toBeNull();
});

test("repairAction: the prompt carries the failure + live page facts, and the reply is grounded", async () => {
	let seen = "";
	const model = new FakeModelClient((msgs: ModelMessage[]) => {
		seen = msgs
			.map((m) =>
				typeof m.content === "string"
					? m.content
					: m.content.map((c) => (c.type === "text" ? c.text : "[img]")).join(" "),
			)
			.join("\n");
		return '{"kind":"click","target":"저장"}';
	});
	const fixed = await repairAction(model, {
		action: { kind: "click", target: "저장" },
		error: 'locator.click: Timeout 4000ms exceeded for "저장"',
		html: LIVE_HTML,
		url: "/approvals/1",
		title: "결재 의견 저장",
		steps: ['의견을 입력하고 "저장"을 클릭한다'],
		expected: "저장되었습니다",
	});
	// grounded onto the real label, not the model's paraphrase
	expect(fixed).toEqual({ kind: "click", target: "저장하기" });
	expect(seen).toContain('FAILED ACTION: click "저장"');
	expect(seen).toContain("Timeout 4000ms exceeded");
	expect(seen).toContain("저장하기"); // the live scan is in the prompt
	expect(seen).toContain("결재 의견 저장");
});

test("repairAction returns null when the model declines or hallucinates a target", async () => {
	const req = {
		action: { kind: "click" as const, target: "저장" },
		error: "boom",
		html: LIVE_HTML,
		url: "/approvals/1",
	};
	expect(await repairAction(new FakeModelClient(() => '{"kind":"none"}'), req)).toBeNull();
	expect(await repairAction(new FakeModelClient(() => '{"kind":"click","target":"결재 승인"}'), req)).toBeNull();
	expect(await repairAction(new FakeModelClient(() => "죄송합니다, 잘 모르겠습니다"), req)).toBeNull();
	expect(await repairAction(new FakeModelClient(() => '{"kind":"click"}'), req)).toBeNull();
});

test("repairAction attaches the screenshot when one is available (vision sees blocking popups)", async () => {
	let parts = 0;
	const model = new FakeModelClient((msgs: ModelMessage[]) => {
		const user = msgs.find((m) => m.role === "user");
		parts = typeof user?.content === "string" ? 0 : (user?.content.length ?? 0);
		return '{"kind":"none"}';
	});
	await repairAction(model, {
		action: { kind: "click", target: "저장" },
		error: "boom",
		html: LIVE_HTML,
		url: "/approvals/1",
		screenshot: "data:image/png;base64,AAAA",
	});
	expect(parts).toBe(2); // text + image
});

test("groundAction snaps a click onto a form control, because a filter is clicked to open it", () => {
	// The sheets this engine reads are full of "기관유형 필터 선택". Form controls were left out of the
	// clickable vocabulary, so grounding refused to snap them while `targetOnScreen` — same file —
	// counted them as present. The runner spent the full locator budget waiting for a label grounding
	// could have handed it.
	// `label[for]` + a sibling control, which is what the live app renders (its scan listed
	// 기관 유형 | 전체 | 상태 | 기관명 as separate fields).
	const filters = extractStructure(
		`<main><h1>전체 계정 관리</h1>
		 <label for="t">기관 유형</label><select id="t"><option>전체</option></select>
		 <label for="s">상태</label><select id="s"><option>전체</option></select>
		 <button>검색</button></main>`,
		"/account",
	);
	expect(groundAction({ kind: "click", target: "기관유형" }, filters)).toEqual({
		kind: "click",
		target: "기관 유형",
	});
	// A real button still wins over a field of the same name.
	expect(groundAction({ kind: "click", target: "검색" }, filters)).toEqual({ kind: "click", target: "검색" });
});

test("pregroundAction leaves an exact target alone and never invents one", () => {
	const html = "<main><button>저장하기</button><label>의견<input /></label></main>";
	// Exact match → untouched. Rewriting a target that already resolves could only break a working
	// case on a page where something else also fuzzy-matches.
	expect(pregroundAction({ kind: "click", target: "저장하기" }, html, "/x")).toBeNull();
	// Nothing comparable on screen → no guess.
	expect(pregroundAction({ kind: "click", target: "결재 반려" }, html, "/x")).toBeNull();
	// A blank SPA shell must not be read as drift.
	expect(pregroundAction({ kind: "click", target: "저장" }, "<div id=app></div>", "/x")).toBeNull();
	// goto is not a label, so it is out of scope here.
	expect(pregroundAction({ kind: "goto", path: "/x" }, html, "/x")).toBeNull();
});

test("pregroundAction separates a spacing normalization from a partial-match guess", () => {
	const html = `<main><label for="t">기관 유형</label><select id="t"><option>전체</option></select>
		<button>신규 계정 생성</button></main>`;
	// Same element, normalized name → no heal event, so the case can still pass.
	expect(pregroundAction({ kind: "click", target: "기관유형" }, html, "/account")).toEqual({
		action: { kind: "click", target: "기관 유형" },
		normalizedOnly: true,
	});
	// "생성" is only *part of* a longer label — which control was meant is a guess, and a guess has to
	// stay visible to a human.
	expect(pregroundAction({ kind: "click", target: "생성" }, html, "/account")).toEqual({
		action: { kind: "click", target: "신규 계정 생성" },
		normalizedOnly: false,
	});
});
