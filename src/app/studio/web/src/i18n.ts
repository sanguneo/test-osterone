import { useSyncExternalStore } from "react";
import type { AssertionView } from "./types";

/** Display language for engine-generated interpretation phrasing (assertion detail, self-heal). */
export type Lang = "ko" | "en";

const KEY = "to_lang";
let current: Lang = (() => {
	try {
		return localStorage.getItem(KEY) === "en" ? "en" : "ko";
	} catch {
		return "ko";
	}
})();
const listeners = new Set<() => void>();

export function getLang(): Lang {
	return current;
}

export function setLang(lang: Lang): void {
	if (lang === current) return;
	current = lang;
	try {
		localStorage.setItem(KEY, lang);
	} catch {}
	for (const fn of listeners) fn();
}

export function useLang(): Lang {
	return useSyncExternalStore(
		(fn) => {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		() => current,
		() => current,
	);
}

/**
 * Localize one assertion's detail. English reuses the engine's canonical string
 * (exact, includes URLs on failures); Korean is rebuilt from the structured
 * kind + value. Falls back to the stored English `detail` for pre-i18n runs.
 */
export function formatAssertion(a: AssertionView, lang: Lang): string {
	if (lang === "en" || !a.kind || a.value === undefined) return a.detail;
	const q = `"${a.value}"`;
	switch (a.kind) {
		case "urlIncludes":
			return a.passed ? `URL에 ${q} 있음` : `URL에 ${q} 없음`;
		case "textIncludes":
			return a.passed ? `텍스트에 ${q} 있음` : `텍스트에 ${q} 없음`;
		case "textNotIncludes":
			return a.passed ? `텍스트에 ${q} 없음(정상)` : `텍스트에 ${q} 있음(금지)`;
		default:
			return a.detail;
	}
}

/** Prefix for the self-heal note line. */
export function selfHealPrefix(lang: Lang): string {
	return lang === "en" ? "self-heal" : "자가복구";
}
