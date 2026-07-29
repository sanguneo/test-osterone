import { expect, test } from "bun:test";
import { type FakeAction, FakePage, type Page, type PageSnapshot } from "../src/execute/page.ts";
import {
	attemptLogin,
	extractStructure,
	loginErrorMessage,
	pickFieldLabel,
	reconApp,
	reduceRecon,
} from "../src/interpret/recon.ts";
import { FakeModelClient, type ModelMessage } from "../src/model/model-client.ts";

const LOGIN_HTML = `<!doctype html><html><head><title>acme 로그인</title></head><body>
	<h1>로그인</h1>
	<form>
		<input type="text" placeholder="아이디를 입력해주세요" name="loginId" />
		<input type="password" placeholder="비밀번호를 입력해주세요" name="loginPw" />
		<input type="hidden" name="csrf" value="x" />
		<button type="submit">로그인</button>
	</form>
</body></html>`;

const HOME_HTML = `<!doctype html><html><head><title>acme 홈</title></head><body>
	<nav>
		<a href="/orders">주문 관리</a>
		<a href="/settings?tab=1#top">환경 설정</a>
		<a href="https://external.example.com">외부 링크</a>
		<a href="#top">맨 위로</a>
		<a href="/orders">주문 관리</a>
	</nav>
	<h1>대시보드</h1>
	<h2>단지 95001</h2>
	<button>새 결재 요청</button>
	<span role="button">알림</span>
</body></html>`;

const ORDERS_HTML = `<!doctype html><html><head><title>주문 관리</title></head><body>
	<h1>주문</h1>
	<table><thead><tr><th>번호</th><th>상태</th><th>금액</th></tr></thead></table>
</body></html>`;

const SETTINGS_HTML = `<!doctype html><html><head><title>환경 설정</title></head><body>
	<h1>설정</h1>
	<label>알림 이메일</label>
	<input type="text" aria-label="표시 이름" />
	<textarea placeholder="메모"></textarea>
</body></html>`;

const CREDS = { username: "test_member7", password: "1234" };

/** Scripted app: throws on unmatched fill/click targets so login-hint iteration is exercised. */
function reconReducer(action: FakeAction, state: PageSnapshot, inputs: Record<string, string>): PageSnapshot {
	if (action.kind === "goto") {
		const path = action.target;
		if (path === "/" || path.includes("/login")) return { url: "/auth/login", text: "로그인", html: LOGIN_HTML };
		if (path.includes("/orders")) return { url: "/orders", text: "주문", html: ORDERS_HTML };
		if (path.includes("/settings")) return { url: "/settings", text: "설정", html: SETTINGS_HTML };
		return { url: path, text: "page", html: `<title>page</title><main>${path}</main>` };
	}
	if (action.kind === "fill") {
		if (action.target === "아이디를 입력해주세요" || action.target === "비밀번호를 입력해주세요") return state;
		throw new Error(`no field "${action.target}"`);
	}
	if (action.target === "로그인") {
		const ok =
			inputs["아이디를 입력해주세요"] === CREDS.username && inputs["비밀번호를 입력해주세요"] === CREDS.password;
		return ok
			? { url: "/home", text: "홈", html: HOME_HTML }
			: { url: "/auth/login", text: "로그인 실패", html: LOGIN_HTML };
	}
	throw new Error(`no element "${action.target}"`);
}

test("extractStructure parses title, headings, links, fields, buttons, table headers", () => {
	const p = extractStructure(HOME_HTML, "/home");
	expect(p.url).toBe("/home");
	expect(p.title).toBe("acme 홈");
	expect(p.headings).toEqual(["대시보드", "단지 95001"]);
	expect(p.links.map((l) => `${l.label}|${l.href}`)).toEqual([
		"주문 관리|/orders",
		"환경 설정|/settings?tab=1#top",
		"외부 링크|https://external.example.com",
		"맨 위로|#top",
	]);
	expect(p.buttons).toEqual(["새 결재 요청", "알림"]);
});

test("extractStructure reads placeholder / aria-label / label as form fields and skips hidden inputs", () => {
	const login = extractStructure(LOGIN_HTML);
	expect(login.formFields).toEqual(["아이디를 입력해주세요", "비밀번호를 입력해주세요"]);
	expect(login.buttons).toEqual(["로그인"]);

	const settings = extractStructure(SETTINGS_HTML);
	expect(settings.formFields).toEqual(["표시 이름", "메모", "알림 이메일"]);

	const orders = extractStructure(ORDERS_HTML);
	expect(orders.tableHeaders).toEqual(["번호", "상태", "금액"]);
});

test("extractStructure dedupes repeated links and decodes entities", () => {
	const p = extractStructure(`<a href="/x">A &amp; B</a><a href="/x">A &amp; B</a><a href="/y">C</a>`);
	expect(p.links).toEqual([
		{ label: "A & B", href: "/x" },
		{ label: "C", href: "/y" },
	]);
});

test("reduceRecon builds a scan prompt with page facts and returns the trimmed model brief", async () => {
	let seen = "";
	const model = new FakeModelClient((msgs: ModelMessage[]) => {
		seen = msgs.map((m) => m.content).join("\n");
		return "\n- 전자결재 QA 도구\n- 로그인: 아이디/비밀번호\n";
	});
	const brief = await reduceRecon(
		[extractStructure(HOME_HTML, "/home"), extractStructure(ORDERS_HTML, "/orders")],
		model,
	);
	expect(brief).toBe("- 전자결재 QA 도구\n- 로그인: 아이디/비밀번호");
	expect(seen).toContain("주문 관리");
	expect(seen).toContain("table headers: 번호, 상태, 금액");
	expect(seen).toContain("PAGE /home");
	// Real routes, not just labels — otherwise the plan author invents paths that 404.
	expect(seen).toContain("routes: /orders, /settings");
	expect(seen).not.toContain("https://external.example.com");
});

test("reduceRecon returns empty string for an empty scan (no model call needed)", async () => {
	let calls = 0;
	const model = new FakeModelClient(() => {
		calls++;
		return "unused";
	});
	expect(await reduceRecon([], model)).toBe("");
	expect(calls).toBe(0);
});

test("reconApp logs in via hint iteration, scans the landing page, and reduces context", async () => {
	const page = new FakePage({ url: "", text: "", html: "" }, reconReducer);
	const model = new FakeModelClient(() => "- 도메인 브리프");
	const res = await reconApp(page, model, { account: CREDS });
	expect(res.loggedIn).toBe(true);
	expect(res.notes.some((n) => n.startsWith("로그인 완료"))).toBe(true);
	expect(res.pages).toHaveLength(1);
	expect(res.pages[0]?.title).toBe("acme 홈");
	expect(res.context).toBe("- 도메인 브리프");
});

test("reconApp deep-crawls internal nav links (skips external + anchors), capped by navLimit", async () => {
	const page = new FakePage({ url: "", text: "", html: "" }, reconReducer);
	const model = new FakeModelClient(() => "brief");
	const res = await reconApp(page, model, { account: CREDS, deep: true, navLimit: 6 });
	expect(res.pages.map((p) => p.url)).toEqual(["/home", "/orders", "/settings"]);
	expect(res.pages[1]?.tableHeaders).toEqual(["번호", "상태", "금액"]);

	const capped = await reconApp(new FakePage({ url: "", text: "", html: "" }, reconReducer), model, {
		account: CREDS,
		deep: true,
		navLimit: 2,
	});
	expect(capped.pages.map((p) => p.url)).toEqual(["/home", "/orders"]);
});

test("reconApp records a note when login cannot be completed and still scans the public page", async () => {
	const publicOnly = (action: FakeAction): PageSnapshot => {
		if (action.kind === "goto") return { url: "/", text: "공개", html: "<title>공개 랜딩</title><h1>환영</h1>" };
		throw new Error(`unmatchable "${action.target}"`);
	};
	const page = new FakePage({ url: "", text: "", html: "" }, publicOnly);
	const model = new FakeModelClient(() => "브리프");
	const res = await reconApp(page, model, { account: { username: "x", password: "y" } });
	expect(res.loggedIn).toBe(false);
	expect(res.notes.some((n) => n.startsWith("로그인 미완료"))).toBe(true);
	expect(res.pages[0]?.title).toBe("공개 랜딩");
});

test("reconApp notes when the model returns no context", async () => {
	const page = new FakePage({ url: "", text: "", html: "" }, reconReducer);
	const res = await reconApp(page, new FakeModelClient(() => "   "), { account: CREDS });
	expect(res.context).toBe("");
	expect(res.notes.some((n) => n.includes("모델이 컨텍스트를 반환하지 않음"))).toBe(true);
});

test("attemptLogin fills creds, submits, and confirms it left the login form → ok", async () => {
	const page = new FakePage({ url: "", text: "", html: "" }, reconReducer);
	const res = await attemptLogin(page, CREDS);
	expect(res.ok).toBe(true);
});

test("attemptLogin fails when credentials are rejected (still on the login form)", async () => {
	const page = new FakePage({ url: "", text: "", html: "" }, reconReducer);
	const res = await attemptLogin(page, { username: "wrong", password: "nope" }, { settleTimeoutMs: 1200 });
	expect(res.ok).toBe(false);
	expect(res.note).toContain("로그인 화면");
});

test("attemptLogin fails when no login fields are found on the page", async () => {
	const publicOnly = (action: FakeAction): PageSnapshot => {
		if (action.kind === "goto") return { url: "/", text: "공개", html: "<title>공개</title><h1>환영</h1>" };
		throw new Error(`unmatchable "${action.target}"`);
	};
	const page = new FakePage({ url: "", text: "", html: "" }, publicOnly);
	const res = await attemptLogin(page, { username: "x", password: "y" });
	expect(res.ok).toBe(false);
	expect(res.note).toContain("입력 필드");
});

/**
 * Real-world client-rendered login (dev-aptpaper.xperp.co.kr): the first navigation returns an
 * empty app shell, the app then client-redirects to /auth/login, and its copy differs from the
 * authored hints by spacing + a trailing period ("아이디를 입력해 주세요.").
 */
const SPA_SHELL_HTML = `<!doctype html><html><head><title>공문 발송 서비스</title></head><body><div id="__nuxt"></div></body></html>`;
const SPA_LOGIN_HTML = `<!doctype html><html><head><title>공문 발송 서비스</title></head><body>
	<form>
		<label for="loginId">아이디</label>
		<input id="loginId" name="loginId" type="text" placeholder="아이디를 입력해 주세요." />
		<label>비밀번호</label>
		<input id="password" name="password" type="password" placeholder="비밀번호를 입력해 주세요." />
		<button type="submit">로그인</button>
	</form>
</body></html>`;
const SPA_HOME_HTML = `<!doctype html><html><head><title>대시보드</title></head><body><h1>공문 발송</h1></body></html>`;
const SPA_LIVE_TARGETS = ["아이디를 입력해 주세요.", "비밀번호를 입력해 주세요.", "아이디", "비밀번호"];

class SpaLoginPage implements Page {
	url = "/";
	text = "";
	html = SPA_SHELL_HTML;
	polls = 0;
	readonly filled: Record<string, string> = {};
	constructor(
		private readonly mountAfterPolls: number,
		/** Whether the app prints an explicit rejection notice (vs. a submit that silently does nothing). */
		private readonly showsRejection = true,
	) {}
	async goto(path: string): Promise<void> {
		this.url = path;
		this.html = SPA_SHELL_HTML;
		this.text = "";
		this.polls = 0;
	}
	async snapshot(): Promise<PageSnapshot> {
		this.polls++;
		if (this.html === SPA_SHELL_HTML && this.polls > this.mountAfterPolls) {
			this.url = "/auth/login?returnUrl=/";
			this.html = SPA_LOGIN_HTML;
			this.text = "아이디\n비밀번호\n로그인";
		}
		return { url: this.url, text: this.text, html: this.html };
	}
	/** Only labels the live DOM actually exposes resolve — same contract as Playwright's locators. */
	async fill(target: string, value: string): Promise<void> {
		if (!SPA_LIVE_TARGETS.includes(target)) throw new Error(`no field "${target}"`);
		this.filled[target] = value;
	}
	async click(target: string): Promise<void> {
		if (target !== "로그인") throw new Error(`no element "${target}"`);
		const ok = this.filled["아이디를 입력해 주세요."] === "u1" && this.filled["비밀번호를 입력해 주세요."] === "p1";
		this.url = ok ? "/home" : "/auth/login?returnUrl=/";
		this.html = ok ? SPA_HOME_HTML : SPA_LOGIN_HTML;
		const refused = this.showsRejection
			? "아이디\n비밀번호\n로그인\n로그인 안내\n아이디 또는 비밀번호를 확인해 주세요."
			: "아이디\n비밀번호\n로그인";
		this.text = ok ? "공문 발송" : refused;
	}
}

test("pickFieldLabel matches live copy that differs from the hint by spacing/punctuation", () => {
	const fields = ["아이디를 입력해 주세요.", "비밀번호를 입력해 주세요.", "아이디", "비밀번호"];
	expect(pickFieldLabel(fields, ["아이디를 입력해주세요", "아이디"])).toBe("아이디를 입력해 주세요.");
	expect(pickFieldLabel(fields, ["비밀번호를 입력해주세요", "비밀번호"])).toBe("비밀번호를 입력해 주세요.");
});

test("pickFieldLabel honors hint priority, prefers the shortest match, and reports no match", () => {
	// Hint order wins over field order: the second hint matches nothing, the third does.
	expect(pickFieldLabel(["사번", "사용자 이름"], ["이메일", "Username", "사용자 이름"])).toBe("사용자 이름");
	// Within one hint, the tightest field wins (never a longer field that merely contains it).
	expect(pickFieldLabel(["아이디 찾기 질문", "아이디"], ["아이디"])).toBe("아이디");
	expect(pickFieldLabel(["제목", "내용"], ["아이디", "이메일"])).toBeNull();
	// A one-character hint is too weak to anchor a field and is skipped.
	expect(pickFieldLabel(["제목"], ["목"])).toBeNull();
});

test("loginErrorMessage surfaces the app's rejection line and ignores ordinary copy", () => {
	expect(loginErrorMessage("아이디\n비밀번호\n로그인\n아이디 또는 비밀번호를 확인해 주세요.")).toBe(
		"아이디 또는 비밀번호를 확인해 주세요.",
	);
	expect(loginErrorMessage("Invalid credentials")).toBe("Invalid credentials");
	expect(loginErrorMessage("아이디\n비밀번호\n로그인")).toBe("");
});

test("attemptLogin waits for a client-rendered login form and fills the live labels → ok", async () => {
	const page = new SpaLoginPage(2);
	const res = await attemptLogin(page, { username: "u1", password: "p1" }, { settleTimeoutMs: 1500 });
	expect(res.ok).toBe(true);
	expect(page.filled).toEqual({ "아이디를 입력해 주세요.": "u1", "비밀번호를 입력해 주세요.": "p1" });
});

test("attemptLogin reports the app's own rejection message when credentials are refused", async () => {
	const page = new SpaLoginPage(0);
	const res = await attemptLogin(page, { username: "u1", password: "nope" }, { settleTimeoutMs: 1200 });
	expect(res.ok).toBe(false);
	expect(res.note).toContain("아이디 또는 비밀번호를 확인해 주세요.");
});

test("attemptLogin marks an app-refused credential as `rejected` so callers never retry it into a lockout", async () => {
	const refused = await attemptLogin(
		new SpaLoginPage(0),
		{ username: "u1", password: "nope" },
		{ settleTimeoutMs: 1200 },
	);
	expect(refused.ok).toBe(false);
	expect(refused.rejected).toBe(true);

	// Submit swallowed with no message on screen — transient, so a caller may retry this one.
	const silent = await attemptLogin(
		new SpaLoginPage(0, false),
		{ username: "u1", password: "nope" },
		{ settleTimeoutMs: 1200 },
	);
	expect(silent.ok).toBe(false);
	expect(silent.rejected).toBeFalsy();
});

test("attemptLogin gives up early on a rendered page that has no login form, listing what it saw", async () => {
	const noForm = (action: FakeAction): PageSnapshot => {
		if (action.kind === "goto")
			return { url: "/", text: "검색", html: "<title>공개</title><h1>환영</h1><input placeholder='검색어' />" };
		throw new Error(`unmatchable "${action.target}"`);
	};
	const page = new FakePage({ url: "", text: "", html: "" }, noForm);
	const started = Date.now();
	const res = await attemptLogin(page, { username: "x", password: "y" }, { fieldWaitMs: 8000 });
	expect(res.ok).toBe(false);
	expect(res.note).toContain("검색어");
	expect(Date.now() - started).toBeLessThan(4000);
});

/**
 * An app whose first submit is swallowed — the handler is not attached yet — and whose second works.
 * Exactly what this project's app does: the runner survived it because it retried, and recon did not,
 * so app analysis kept scanning the login page.
 */
class FlakyFirstSubmitPage implements Page {
	private submits = 0;
	private signedIn = false;
	readonly resets: number[] = [];
	async goto(): Promise<void> {
		this.signedIn = false;
	}
	async fill(): Promise<void> {}
	async click(): Promise<void> {
		this.submits++;
		// First submit does nothing at all; the second authenticates.
		if (this.submits >= 2) this.signedIn = true;
	}
	async resetSession(): Promise<void> {
		this.resets.push(this.submits);
		this.signedIn = false;
	}
	async snapshot(): Promise<PageSnapshot> {
		return this.signedIn
			? { url: "/dashboard", text: "대시보드", html: "<main>대시보드</main>" }
			: {
					url: "/login",
					text: "아이디 비밀번호 로그인",
					html: "<input placeholder='아이디' /><input placeholder='비밀번호' />",
				};
	}
}

test("attemptLogin retries a swallowed submit and reports why, so every caller gets the same behaviour", async () => {
	const page = new FlakyFirstSubmitPage();
	const notes: string[] = [];
	const res = await attemptLogin(
		page,
		{ username: "u1", password: "p1" },
		{ settleTimeoutMs: 1200, onRetry: (n) => notes.push(n) },
	);
	expect(res.ok).toBe(true);
	// The caller is told rather than being retried behind its back — the run surfaces this as a notice.
	expect(notes).toHaveLength(1);
	expect(notes[0]).toContain("로그인 화면에 머무름");
	// The session is cleared between attempts so the second starts from a known state.
	expect(page.resets).toHaveLength(1);
});

test("attemptLogin never retries a credential the app refused, however many retries are allowed", async () => {
	// A refused password re-submitted is a locked account, not a second chance.
	const page = new SpaLoginPage(0);
	const notes: string[] = [];
	const res = await attemptLogin(
		page,
		{ username: "u1", password: "nope" },
		{ settleTimeoutMs: 1200, retries: 3, onRetry: (n) => notes.push(n) },
	);
	expect(res.ok).toBe(false);
	expect(res.rejected).toBe(true);
	expect(notes).toEqual([]);
});
