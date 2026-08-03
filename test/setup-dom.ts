/**
 * DOM globals for the Studio UI tests.
 *
 * The suite is deliberately browser-free — there is even a test asserting that importing the browser
 * adapter does not pull in playwright — so UI coverage uses a DOM shim rather than a real browser.
 * That keeps `bun test` deterministic and fast, which is the only reason the engine's numbers are
 * trustworthy.
 *
 * What the shim cannot answer, it must not be asked. happy-dom implements the DOM API, not user-agent
 * behaviour: a `<dialog>` opened with `showModal()` will not raise `cancel` when Escape is pressed,
 * because that is the browser's doing. So a UI test here may assert what the component's own code
 * does with an event, never what a browser would generate on its own.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * The shim may own the document; it may not own the network.
 *
 * Registering it replaces `fetch` and friends with a window implementation, and the orchestration
 * contract test drives a *real* HTTP worker over a real socket — measured, it failed with
 * `NetworkError: Parse Error` the moment this preload was added, in a test that has nothing to do with
 * the UI. A preload that changes engine behaviour is worse than no UI coverage at all, so Bun's own
 * HTTP surface is put back after registration.
 */
const native = {
	fetch: globalThis.fetch,
	Request: globalThis.Request,
	Response: globalThis.Response,
	Headers: globalThis.Headers,
};

if (typeof document === "undefined") GlobalRegistrator.register({ url: "http://localhost:8686/" });

Object.assign(globalThis, native);

// React flushes effects inside `act(...)` only when it is told it is in a test environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
