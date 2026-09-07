import { normLabel, type RouteEntry } from "./recon.ts";

/** Resolve the longest unambiguous observed route label; a root path cannot identify a destination. */
export function matchRoute(text: string, routes: readonly RouteEntry[] = []): RouteEntry | null {
	const haystack = normLabel(text);
	const hits = routes
		.filter((route) => {
			const label = normLabel(route.label);
			return route.path !== "/" && label.length >= 2 && haystack.includes(label);
		})
		.sort((a, b) => normLabel(b.label).length - normLabel(a.label).length);
	const best = hits[0];
	if (!best) return null;
	if (hits.some((route) => route.path !== best.path && normLabel(route.label).length === normLabel(best.label).length))
		return null;
	return best;
}
