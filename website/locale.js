export const countryPreferenceKey = "goodfinds-example-country";

/** Browser language is a hint; only an explicit region identifies a market.
 * @param {readonly string[]} languages
 * @param {string | null} [saved]
 */
export function exampleCountry(languages, saved = null) {
  if (saved === "other") return null;
  if (saved && /^[A-Z]{2}$/u.test(saved)) return saved;
  for (const language of languages) {
    try {
      const region = new Intl.Locale(language).region;
      if (region && /^[A-Z]{2}$/u.test(region)) return region;
    } catch {
      // Ignore malformed hints; never infer residence from language alone.
    }
  }
  return null;
}

export function currentExampleCountry() {
  let saved = null;
  try {
    saved = localStorage.getItem(countryPreferenceKey);
  } catch {
    /* Storage may be disabled. */
  }
  return exampleCountry(navigator.languages, saved);
}

/** @param {string} country */
export function saveExampleCountry(country) {
  try {
    localStorage.setItem(countryPreferenceKey, country);
  } catch {
    /* The selection still works for this page. */
  }
  window.dispatchEvent(new CustomEvent("goodfinds-country-change", { detail: country }));
}
