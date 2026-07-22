import type { ReactNode } from "react";

export type IconName =
	| "add"
	| "arrow"
	| "check"
	| "close"
	| "edit"
	| "import"
	| "model"
	| "overview"
	| "play"
	| "project"
	| "review"
	| "rules"
	| "search"
	| "sheet"
	| "trash"
	| "warning"
	| "x";

function assertNever(value: never): never {
	throw new Error(`Unsupported icon: ${value}`);
}

function iconPath(name: IconName): ReactNode {
	switch (name) {
		case "add":
			return <path d="M12 5v14M5 12h14" />;
		case "arrow":
			return <path d="m9 6 6 6-6 6" />;
		case "check":
			return <path d="m5 12 4 4L19 6" />;
		case "close":
			return <path d="m6 6 12 12M18 6 6 18" />;
		case "edit":
			return (
				<>
					<path d="m14 5 5 5" />
					<path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16v4Z" />
				</>
			);
		case "import":
			return (
				<>
					<path d="M12 4v10" />
					<path d="m8 8 4-4 4 4" />
					<path d="M5 15v4h14v-4" />
				</>
			);
		case "model":
			return (
				<>
					<path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
					<rect x="7" y="7" width="10" height="10" rx="3" />
					<path d="M10 11h.01M14 11h.01M10 14h4" />
				</>
			);
		case "overview":
			return (
				<>
					<rect x="4" y="4" width="6" height="6" rx="1" />
					<rect x="14" y="4" width="6" height="6" rx="1" />
					<rect x="4" y="14" width="6" height="6" rx="1" />
					<path d="M14 17h6M17 14v6" />
				</>
			);
		case "play":
			return <path d="m8 5 11 7-11 7V5Z" />;
		case "project":
			return (
				<>
					<path d="M4 7h6l2 2h8v10H4V7Z" />
					<path d="M4 10h16" />
				</>
			);
		case "review":
			return (
				<>
					<path d="M6 4h12v16H6z" />
					<path d="M9 9h6M9 13h4" />
				</>
			);
		case "rules":
			return (
				<>
					<path d="M5 6h14M5 12h14M5 18h14" />
					<circle cx="9" cy="6" r="2" />
					<circle cx="15" cy="12" r="2" />
					<circle cx="11" cy="18" r="2" />
				</>
			);
		case "search":
			return (
				<>
					<circle cx="11" cy="11" r="6" />
					<path d="m16 16 4 4" />
				</>
			);
		case "sheet":
			return (
				<>
					<path d="M6 3h9l3 3v15H6V3Z" />
					<path d="M15 3v4h4M9 11h6M9 15h6" />
				</>
			);
		case "trash":
			return (
				<>
					<path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13" />
					<path d="M10 11v5M14 11v5" />
				</>
			);
		case "warning":
			return (
				<>
					<path d="M12 4 3 20h18L12 4Z" />
					<path d="M12 9v5M12 17h.01" />
				</>
			);
		case "x":
			return <path d="m7 7 10 10M17 7 7 17" />;
		default:
			return assertNever(name);
	}
}

export function Icon({ name, size = 18 }: { readonly name: IconName; readonly size?: number }) {
	return (
		<svg
			aria-hidden="true"
			className="icon"
			fill="none"
			height={size}
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth="1.75"
			viewBox="0 0 24 24"
			width={size}
		>
			{iconPath(name)}
		</svg>
	);
}
