import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { useLang } from "../i18n";
import { Icon } from "./Icon";

const S = {
	ko: { close: "닫기" },
	en: { close: "Close" },
} as const;


interface ModalShellProps {
	readonly children: ReactNode;
	readonly label: string;
	readonly onClose: () => void;
	readonly wide?: boolean;
}

export function ModalShell({ children, label, onClose, wide = false }: ModalShellProps) {
	const t = S[useLang()];
	const dialogRef = useRef<HTMLDialogElement>(null);
	const onCloseRef = useRef(onClose);
	useEffect(() => {
		onCloseRef.current = onClose;
	}, [onClose]);

	/**
	 * One gate every close path passes through, at most once per mount.
	 *
	 * Three things here ask the parent to dismiss this dialog — Escape, the backdrop, the close button —
	 * and with `showModal()` the browser adds one of its own, because Escape also raises `cancel`. They
	 * used to call the parent independently, so a single Escape asked twice, and the cleanup's own
	 * `close()` could ask again *during* unmount, after the parent had already moved on. A mounted modal
	 * only ever needs dismissing once; the parent is what removes it. So every path stays (each one is
	 * the right one in some browser) and the request is what becomes single.
	 */
	const closedRef = useRef(false);
	const requestClose = useCallback(() => {
		if (closedRef.current) return;
		closedRef.current = true;
		onCloseRef.current();
	}, []);

	useEffect(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const dialog = dialogRef.current;
		if (dialog && !dialog.open) dialog.showModal();
		dialog?.querySelector<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")?.focus();
		function closeOnEscape(event: KeyboardEvent) {
			if (event.key === "Escape") requestClose();
		}
		function closeOnBackdrop(event: MouseEvent) {
			if (event.target === dialog) requestClose();
		}
		window.addEventListener("keydown", closeOnEscape);
		dialog?.addEventListener("click", closeOnBackdrop);
		return () => {
			window.removeEventListener("keydown", closeOnEscape);
			dialog?.removeEventListener("click", closeOnBackdrop);
			if (dialog?.open) dialog.close();
			previous?.focus();
		};
	}, [requestClose]);

	return (
		<dialog
			ref={dialogRef}
			className="modal-native"
			aria-label={label}
			onCancel={(event) => {
				event.preventDefault();
				requestClose();
			}}
		>
			<div className={`modal${wide ? " modal-wide" : ""}`}>
				<button className="icon-button modal-close" type="button" aria-label={t.close} onClick={requestClose}>
					<Icon name="close" />
				</button>
				{children}
			</div>
		</dialog>
	);
}
