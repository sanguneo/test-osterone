/**
 * First UI coverage in this repo (debt M2). Component-level and deterministic: no browser, no server.
 *
 * `ModalShell` is the right place to start. Every dialog in Studio goes through it, it owns focus
 * restoration, and it had *three* independent ways to ask the parent to close — a window `keydown`,
 * the native `cancel`, and the native `close` that its own cleanup provokes. Nothing observed that,
 * because nothing rendered it.
 */
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ModalShell } from "../src/app/studio/web/src/components/ModalShell.tsx";

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	host?.remove();
	root = null;
	host = null;
});

/** Mount a ModalShell with one focusable child, and hand back the dialog it opened. */
async function mount(onClose: () => void): Promise<HTMLDialogElement> {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<ModalShell label="시트 편집" onClose={onClose}>
				<input aria-label="이름" />
			</ModalShell>,
		);
	});
	const dialog = host.querySelector("dialog");
	if (!dialog) throw new Error("ModalShell rendered no dialog");
	return dialog as HTMLDialogElement;
}

const pressEscape = () =>
	act(async () => {
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	});

test("ModalShell opens as a modal and puts focus inside it", async () => {
	let closes = 0;
	const dialog = await mount(() => closes++);
	expect(dialog.open).toBe(true);
	// A dialog that opens without moving focus leaves the keyboard behind on the page underneath. Which
	// element wins is the component's business; that focus is inside the dialog is the contract.
	expect(dialog.contains(document.activeElement)).toBe(true);
	expect(closes).toBe(0);
});

test("ModalShell asks the parent to close at most once per mount", async () => {
	// The defect this test exists for: every close path called the parent independently. With
	// `showModal()` a single Escape is *two* of them — this component's key listener and the browser's
	// own `cancel` event — and the cleanup's `close()` could ask again during unmount, after the parent
	// had already moved on. Measured against the old code, one Escape plus a backdrop click asked three
	// times. A mounted modal only ever needs dismissing once; the parent is what removes it.
	let closes = 0;
	const dialog = await mount(() => closes++);
	await pressEscape();
	expect(closes).toBe(1);
	// A second Escape, and the backdrop for good measure: the parent is already closing this dialog.
	await pressEscape();
	await act(async () => {
		dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	expect(closes).toBe(1);
	// Nor is unmounting a close request.
	await act(async () => root?.unmount());
	root = null;
	expect(closes).toBe(1);
});

test("ModalShell closes on the backdrop and on its close button", async () => {
	let closes = 0;
	const dialog = await mount(() => closes++);
	await act(async () => {
		dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	expect(closes).toBe(1);

	let buttonCloses = 0;
	const second = await mount(() => buttonCloses++);
	const button = second.querySelector<HTMLElement>("button.modal-close");
	expect(button).not.toBeNull();
	await act(async () => {
		button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	expect(buttonCloses).toBe(1);
});

test("ModalShell gives focus back to whatever had it before the dialog opened", async () => {
	const opener = document.createElement("button");
	opener.textContent = "시트 편집";
	document.body.appendChild(opener);
	opener.focus();
	expect(document.activeElement).toBe(opener);

	await mount(() => {});
	expect(document.activeElement).not.toBe(opener);
	await act(async () => root?.unmount());
	root = null;
	// Losing the caller's focus on close is how keyboard users end up back at the top of the document.
	expect(document.activeElement).toBe(opener);
	opener.remove();
});
