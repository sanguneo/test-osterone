/**
 * A tiny self-contained web app used as a live demo target for test-osterone.
 * It is served over real HTTP (node:http, so it runs under both Node and Bun)
 * so the headless-Chromium runner exercises the real browser path (navigation,
 * form fill, click, DOM text assertions) with no external network and fully
 * deterministic behavior.
 *
 * Valid credentials: admin / secret.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>test-osterone demo</title></head>
<body>
  <h1>Sign in</h1>
  <input id="u" aria-label="Username" placeholder="Username" autocomplete="off" />
  <input id="p" type="password" aria-label="Password" placeholder="Password" autocomplete="off" />
  <button id="login" type="button">Log in</button>
  <div id="result" role="status"></div>
  <script>
    document.getElementById("login").addEventListener("click", function () {
      var u = document.getElementById("u").value;
      var p = document.getElementById("p").value;
      var r = document.getElementById("result");
      r.textContent =
        u === "admin" && p === "secret"
          ? "Welcome, admin. Dashboard loaded."
          : "Invalid credentials. Please try again.";
    });
  </script>
</body>
</html>`;

export interface Fixture {
	/** Base URL the runner points at, e.g. http://localhost:53421 */
	url: string;
	/** Stop the server. */
	stop: () => void;
}

/** Start the fixture app on an ephemeral port (0 = OS-assigned). */
export function startFixture(port = 0): Promise<Fixture> {
	return new Promise((resolve) => {
		const server = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(PAGE);
		});
		server.listen(port, () => {
			const addr = server.address() as AddressInfo;
			resolve({ url: `http://localhost:${addr.port}`, stop: () => server.close() });
		});
	});
}
