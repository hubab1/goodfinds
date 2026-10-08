import sources from "../data/search-cover-sources.json" with { type: "json" };

export const rentalCovers = { neutral: sources.rental, ...sources.rental_presets };

// Only explicit country answers or country suffixes choose a regional default.
// Ambiguous city names, currency and the viewer's locale leave the neutral cover.
const countries: Record<string, keyof typeof rentalCovers> = {
  us: "us",
  usa: "us",
  "united states": "us",
  "united states of america": "us",
  ca: "ca",
  canada: "ca",
  au: "au",
  australia: "au",
  fr: "fr",
  france: "fr",
  de: "de",
  germany: "de",
  deutschland: "de",
  gb: "gb",
  uk: "gb",
  "united kingdom": "gb",
  "great britain": "gb",
};

function countryKey(value: unknown, fromArea = false) {
  if (typeof value !== "string") return undefined;
  const name = value.trim().toLowerCase().replace(/\./g, "");
  // CA and DE also name US states. They need a structured country answer.
  if (fromArea && ["ca", "de"].includes(name)) return undefined;
  return countries[name];
}

export function rentalCoverFor(values: Record<string, unknown>) {
  if (typeof values["country"] === "string")
    return rentalCovers[countryKey(values["country"]) ?? "neutral"];
  const area = typeof values["area"] === "string" ? values["area"] : "";
  const country = area.split(",").at(-1);
  return rentalCovers[countryKey(country, true) ?? "neutral"];
}
