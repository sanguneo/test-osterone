import { useEffect, useRef, type ReactNode } from "react";
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

	useEffect(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const dialog = dialogRef.current;
		if (dialog && !dialog.open) dialog.showModal();
		dialog?.querySelector<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")?.focus();
		function closeOnEscape(event: KeyboardEvent) {
			if (event.key === "Escape") onCloseRef.current();
		}
		function closeOnBackdrop(event: MouseEvent) {
			if (event.target === dialog) onCloseRef.current();
		}
		window.addEventListener("keydown", closeOnEscape);
		dialog?.addEventListener("click", closeOnBackdrop);
		return () => {
			window.removeEventListener("keydown", closeOnEscape);
			dialog?.removeEventListener("click", closeOnBackdrop);
			if (dialog?.open) dialog.close();
			previous?.focus();
		};
	}, []);

	return (
		<dialog
			ref={dialogRef}
			className="modal-native"
			aria-label={label}
			onCancel={(event) => { event.preventDefault(); onCloseRef.current(); }}
			onClose={() => onCloseRef.current()}
		>
			<div className={`modal${wide ? " modal-wide" : ""}`}>
				<button className="icon-button modal-close" type="button" aria-label={t.close} onClick={() => onCloseRef.current()}>
					<Icon name="close" />
				</button>
				{children}
			</div>
		</dialog>
	);
}
