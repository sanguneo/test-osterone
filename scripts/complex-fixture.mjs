/**
 * Complex demo app for stress-testing the test-osterone engine end-to-end.
 * A small localStorage-authenticated SPA served over HTTP on a fixed port so a
 * studio project can point its baseUrl at it. Exercises: login (precondition),
 * an onboarding popup overlay, LNB navigation, tabs, a form with an async toast,
 * a color-only badge (vision), and a native confirm() dialog.
 *
 * Credentials: admin / secret.   Run: node scripts/complex-fixture.mjs [port]
 */
import { createServer } from "node:http";

const PAGE = `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8" /><title>복잡샘플 데모</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; color: #1a1a1a; }
  .login { max-width: 320px; margin: 80px auto; display: grid; gap: 10px; }
  .login input, .login button { padding: 10px; font-size: 15px; }
  .lnb { position: fixed; left: 0; top: 0; width: 170px; height: 100vh; background: #14181f; color: #e8eaed; padding: 16px; box-sizing: border-box; }
  .lnb b { display: block; margin-bottom: 12px; }
  .lnb a { display: block; color: #c8ccd2; padding: 9px 8px; cursor: pointer; border-radius: 6px; }
  .lnb a:hover { background: #232833; }
  .bellrow { margin-top: 22px; display: flex; align-items: center; gap: 8px; font-size: 14px; }
  .bell { display: inline-block; width: 22px; height: 22px; border-radius: 50%; }
  .bell.on { background: #e53935; box-shadow: 0 0 0 3px rgba(229,57,53,.3); }
  .bell.off { background: #6b7280; }
  .main { margin-left: 190px; padding: 24px; }
  .tab { display: inline-block; padding: 8px 14px; cursor: pointer; border: 1px solid #d0d5dd; border-radius: 6px; margin-right: 6px; }
  .tab.active { background: #2b2f36; color: #fff; border-color: #2b2f36; }
  .modal { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 1000; display: flex; align-items: center; justify-content: center; }
  .modal .box { background: #fff; padding: 28px; border-radius: 10px; max-width: 360px; }
  .toast { position: fixed; bottom: 24px; right: 24px; background: #2e7d32; color: #fff; padding: 12px 18px; border-radius: 8px; }
  button { cursor: pointer; }
  .btn { padding: 8px 14px; border: 1px solid #c0c7d0; border-radius: 6px; background: #fff; }
  .primary { background: #2563eb; color: #fff; border-color: #2563eb; }
  input[type=text] { padding: 8px; border: 1px solid #c0c7d0; border-radius: 6px; }
</style></head>
<body><div id="app"></div>
<script>
const el = (html) => { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstElementChild; };
function render() {
  const app = document.getElementById("app");
  if (localStorage.getItem("authed") !== "1") { app.innerHTML = loginView(); wireLogin(); return; }
  app.innerHTML = shell();
  for (const a of document.querySelectorAll(".lnb a")) a.addEventListener("click", () => showView(a.dataset.v));
  showView((location.hash || "#home").slice(1) || "home");
  maybePopup();
}
function loginView() {
  return '<div class="login"><h1>로그인</h1>' +
    '<input id="u" type="text" placeholder="아이디" autocomplete="off" />' +
    '<input id="p" type="password" placeholder="비밀번호" autocomplete="off" />' +
    '<button id="login" class="btn primary" type="button">로그인</button>' +
    '<div id="msg" role="status"></div></div>';
}
function wireLogin() {
  document.getElementById("login").addEventListener("click", () => {
    const u = document.getElementById("u").value, p = document.getElementById("p").value;
    if (u === "admin" && p === "secret") { localStorage.setItem("authed", "1"); render(); }
    else document.getElementById("msg").textContent = "아이디 또는 비밀번호가 올바르지 않습니다.";
  });
}
function shell() {
  return '<div class="lnb"><b>XP 데모</b>' +
    '<a data-v="home">홈</a><a data-v="orders">주문</a><a data-v="settings">설정</a>' +
    '<div class="bellrow">알림 <span id="bell" class="bell on" aria-label="알림"></span></div></div>' +
    '<div class="main" id="view"></div>';
}
function showView(v) {
  const view = document.getElementById("view"); if (!view) return;
  if (v === "orders") { view.innerHTML = ordersView(); wireOrders(); }
  else if (v === "settings") { view.innerHTML = settingsView(); wireSettings(); }
  else view.innerHTML = '<h2>홈</h2><p>환영합니다, admin님. 대시보드입니다.</p><p>오늘 처리할 주문이 있습니다.</p>';
}
function ordersView() {
  return '<h2>주문</h2>' +
    '<span class="tab active" data-t="all">전체 주문</span>' +
    '<span class="tab" data-t="wait">대기</span>' +
    '<span class="tab" data-t="done">완료</span>' +
    '<div id="orderlist" style="margin:16px 0">전체 주문 3건이 표시됩니다.</div>' +
    '<button id="neworder" class="btn primary" type="button">새 주문</button>' +
    '<div id="orderform" style="margin-top:12px"></div>';
}
function wireOrders() {
  const counts = { all: "전체 주문 3건이 표시됩니다.", wait: "대기 주문 1건이 표시됩니다.", done: "완료 주문 2건이 표시됩니다." };
  for (const t of document.querySelectorAll(".tab")) t.addEventListener("click", () => {
    for (const x of document.querySelectorAll(".tab")) x.classList.remove("active");
    t.classList.add("active");
    document.getElementById("orderlist").textContent = counts[t.dataset.t];
  });
  document.getElementById("neworder").addEventListener("click", () => {
    document.getElementById("orderform").innerHTML =
      '<input id="title" type="text" placeholder="주문 제목" /> <button id="save" class="btn primary" type="button">저장</button>';
    document.getElementById("save").addEventListener("click", () => {
      setTimeout(() => document.body.appendChild(el('<div class="toast">주문이 저장되었습니다.</div>')), 350);
    });
  });
}
function settingsView() {
  return '<h2>설정</h2><label><input type="checkbox" id="notify" /> 알림 받기</label>' +
    '<div style="margin-top:16px"><button id="del" class="btn" type="button">계정 삭제</button></div>';
}
function wireSettings() {
  document.getElementById("del").addEventListener("click", () => {
    if (confirm("정말 삭제하시겠습니까?")) document.getElementById("view").innerHTML = "<p>계정이 삭제되었습니다.</p>";
  });
}
function maybePopup() {
  if (sessionStorage.getItem("pop") === "1") return;
  sessionStorage.setItem("pop", "1");
  const m = el('<div class="modal"><div class="box"><h3>공지</h3><p>신규 기능 안내 팝업입니다.</p>' +
    '<button id="popclose" class="btn primary" type="button">닫기</button></div></div>');
  document.body.appendChild(m);
  m.querySelector("#popclose").addEventListener("click", () => m.remove());
}
window.addEventListener("hashchange", () => showView((location.hash || "#home").slice(1) || "home"));
render();
</script></body></html>`;

const port = Number(process.argv[2] ?? 8790);
createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	res.end(PAGE);
}).listen(port, () => console.log(`complex-fixture → http://localhost:${port}`));
