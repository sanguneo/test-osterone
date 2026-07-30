/**
 * English demo app — the end-to-end target the engine did not have.
 *
 * Every judgement derivation was built and measured against one Korean sheet, and two of them had no
 * English vocabulary at all until the phrases moved onto the rule. Nothing caught that, because there
 * was no English app to run an English sheet against: the bundled fixtures are a Korean SPA and a
 * single sign-in page. This one carries exactly the shapes those derivations read —
 *
 *  - routes to navigate to (`/accounts`, `/agencies`), for the url assertion;
 *  - a table whose rows open an editor, for "pick any account" (`clickRow`);
 *  - an input with `maxlength`, for "must not accept over N characters" (`fieldAtMost`);
 *  - an input that strips non-digits, for "must not accept letters" (`fieldExcludes`).
 *
 * Credentials: admin / secret.   Run: node scripts/english-fixture.mjs [port]
 */
import { createServer } from "node:http";

const ROWS = [
	{ id: "u-1001", name: "Ada Lovelace", email: "ada@example.com", phone: "5551234567" },
	{ id: "u-1002", name: "Alan Turing", email: "alan@example.com", phone: "5559876543" },
	{ id: "u-1003", name: "Grace Hopper", email: "grace@example.com", phone: "5555550000" },
];

const PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>English demo</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; }
  nav { background: #14181f; color: #fff; padding: 12px 16px; display: flex; gap: 16px; }
  nav a { color: #e8eaed; text-decoration: none; }
  main { padding: 20px; }
  table { border-collapse: collapse; width: 100%; max-width: 640px; }
  th, td { border: 1px solid #d0d3d8; padding: 8px 10px; text-align: left; }
  tbody tr { cursor: pointer; }
  .editor { margin-top: 20px; padding: 16px; border: 1px solid #d0d3d8; max-width: 420px; display: grid; gap: 10px; }
  .login { max-width: 300px; margin: 80px auto; display: grid; gap: 10px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
  <div class="login" id="login">
    <h1>Sign in</h1>
    <label for="u">Username</label><input id="u" autocomplete="off" />
    <label for="p">Password</label><input id="p" type="password" autocomplete="off" />
    <button id="doLogin" type="button">Log in</button>
    <div id="loginMsg" role="status"></div>
  </div>

  <div id="app" hidden>
    <nav>
      <a href="#/accounts" id="navAccounts">Accounts</a>
      <a href="#/agencies" id="navAgencies">Agencies</a>
    </nav>
    <main>
      <h1 id="heading">Accounts</h1>
      <div id="accounts">
        <table>
          <thead><tr><th>ID</th><th>Name</th><th>Email</th></tr></thead>
          <tbody id="rows"></tbody>
        </table>
        <div class="editor" id="editor" hidden>
          <h2>Edit account</h2>
          <label for="email">Email</label>
          <input id="email" maxlength="20" placeholder="Email" autocomplete="off" />
          <label for="phone">Phone</label>
          <input id="phone" placeholder="Phone" autocomplete="off" />
          <button id="save" type="button">Save</button>
          <div id="saveMsg" role="status"></div>
        </div>
      </div>
      <div id="agencies" hidden><p>No agencies yet.</p></div>
    </main>
  </div>

<script>
  var ROWS = ${JSON.stringify(ROWS)};
  function show(view) {
    document.getElementById("accounts").hidden = view !== "accounts";
    document.getElementById("agencies").hidden = view !== "agencies";
    document.getElementById("heading").textContent = view === "agencies" ? "Agencies" : "Accounts";
  }
  function route() {
    var h = location.hash || "#/accounts";
    show(h.indexOf("agencies") >= 0 ? "agencies" : "accounts");
  }
  window.addEventListener("hashchange", route);
  document.getElementById("doLogin").addEventListener("click", function () {
    var ok = document.getElementById("u").value === "admin" && document.getElementById("p").value === "secret";
    if (!ok) { document.getElementById("loginMsg").textContent = "Invalid credentials. Please try again."; return; }
    document.getElementById("login").hidden = true;
    document.getElementById("app").hidden = false;
    var tb = document.getElementById("rows");
    tb.innerHTML = ROWS.map(function (r) {
      return "<tr><td>" + r.id + "</td><td>" + r.name + "</td><td>" + r.email + "</td></tr>";
    }).join("");
    Array.prototype.forEach.call(tb.querySelectorAll("tr"), function (tr, i) {
      tr.addEventListener("click", function () {
        document.getElementById("editor").hidden = false;
        document.getElementById("email").value = ROWS[i].email;
        document.getElementById("phone").value = ROWS[i].phone;
      });
    });
    if (!location.hash) location.hash = "#/accounts";
    route();
  });
  // Phone accepts digits only — the app enforces it, so a case that types letters must see them refused.
  document.getElementById("phone").addEventListener("input", function (e) {
    e.target.value = e.target.value.replace(/[^0-9]/g, "");
  });
  document.getElementById("save").addEventListener("click", function () {
    document.getElementById("saveMsg").textContent = "Account saved.";
  });
</script>
</body>
</html>`;

const port = Number(process.argv[2] ?? 8791);
createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	res.end(PAGE);
}).listen(port, () => console.log(`english fixture → http://localhost:${port}`));
