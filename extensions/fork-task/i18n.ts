/**
 * Language of person-facing text (the tool label). Resolved on every call:
 * `OMOMP_LANG` (`en`/`zh`, trimmed, any case), then the first nonempty of
 * `LC_ALL`, `LC_MESSAGES`, `LANG` (a `zh` prefix means Chinese), then English.
 * Text the model reads stays English.
 */
type Language = "en" | "zh";

function language(): Language {
	const explicit = (process.env.OMOMP_LANG ?? "").trim().toLowerCase();
	if (explicit === "zh" || explicit === "en") return explicit;
	for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"] as const) {
		const value = process.env[key]?.trim();
		if (value) return value.toLowerCase().startsWith("zh") ? "zh" : "en";
	}
	return "en";
}

/** The text for the current language; both are written where the text is used, English first. */
export function tr(en: string, zh: string): string {
	return language() === "zh" ? zh : en;
}
