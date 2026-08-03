import { setLang, useLang } from "../i18n";

/** Compact KO/EN toggle for engine-generated interpretation phrasing (results / dashboard details). */
export function LangToggle() {
	const lang = useLang();
	return (
		// biome-ignore lint/a11y/useSemanticElements: <fieldset> requires a legend and brings UA box styling into the top bar; role="group" + aria-label is the label-only grouping this needs.
		<span className="lang-toggle" role="group" aria-label="해석 표기 언어">
			{(["ko", "en"] as const).map((l) => (
				<button key={l} type="button" className={lang === l ? "on" : ""} aria-pressed={lang === l} onClick={() => setLang(l)}>
					{l === "ko" ? "한글" : "EN"}
				</button>
			))}
		</span>
	);
}
