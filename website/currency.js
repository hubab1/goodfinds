import { currentExampleCountry, exampleCountry } from "./locale.js";

// Curated amounts for fictional examples, not exchange rates or live valuations.
// Region/currency reference: Unicode CLDR supplemental currencyData (2026-10-10).
// https://github.com/unicode-org/cldr-json/blob/main/cldr-json/cldr-core/supplemental/currencyData.json
const examples = [
  { currency: "GBP", regions: "GB GG IM JE", budget: 1250, price: 1100 },
  {
    currency: "USD",
    regions: "US AS BQ EC FM GU IO MH MP PA PR PW TC TL UM VG VI",
    budget: 1600,
    price: 1400,
  },
  {
    currency: "EUR",
    regions:
      "AD AT AX BE BG BL CY DE EE ES FI FR GF GP GR HR IE IT LT LU LV MC MF MQ MT NL PM PT RE SI SK SM TF VA XK YT",
    budget: 1500,
    price: 1300,
  },
  { currency: "CAD", regions: "CA", budget: 2200, price: 1900 },
  { currency: "AUD", regions: "AU CC CX HM KI NF NR TV", budget: 2500, price: 2200 },
  { currency: "NZD", regions: "NZ CK NU PN TK", budget: 2700, price: 2400 },
  { currency: "CHF", regions: "CH LI", budget: 1400, price: 1200 },
  { currency: "SEK", regions: "SE", budget: 17000, price: 15000 },
  { currency: "NOK", regions: "NO SJ BV", budget: 17000, price: 15000 },
  { currency: "DKK", regions: "DK FO GL", budget: 11000, price: 9700 },
  { currency: "PLN", regions: "PL", budget: 6500, price: 5700 },
  { currency: "CZK", regions: "CZ", budget: 38000, price: 33000 },
  { currency: "HUF", regions: "HU", budget: 600000, price: 520000 },
  { currency: "RON", regions: "RO", budget: 7500, price: 6500 },
  { currency: "ISK", regions: "IS", budget: 230000, price: 200000 },
  { currency: "TRY", regions: "TR", budget: 65000, price: 57000 },
  { currency: "UAH", regions: "UA", budget: 70000, price: 61000 },
  { currency: "RSD", regions: "RS", budget: 175000, price: 152000 },
  { currency: "INR", regions: "IN", budget: 140000, price: 120000 },
  { currency: "PKR", regions: "PK", budget: 450000, price: 390000 },
  { currency: "BDT", regions: "BD", budget: 200000, price: 175000 },
  { currency: "LKR", regions: "LK", budget: 500000, price: 440000 },
  { currency: "NPR", regions: "NP", budget: 225000, price: 195000 },
  { currency: "JPY", regions: "JP", budget: 240000, price: 210000 },
  { currency: "CNY", regions: "CN", budget: 12000, price: 10500 },
  { currency: "HKD", regions: "HK", budget: 12500, price: 11000 },
  { currency: "TWD", regions: "TW", budget: 52000, price: 45000 },
  { currency: "KRW", regions: "KR", budget: 2200000, price: 1900000 },
  { currency: "SGD", regions: "SG", budget: 2200, price: 1900 },
  { currency: "MYR", regions: "MY", budget: 7500, price: 6500 },
  { currency: "THB", regions: "TH", budget: 55000, price: 48000 },
  { currency: "VND", regions: "VN", budget: 40000000, price: 35000000 },
  { currency: "IDR", regions: "ID", budget: 25000000, price: 22000000 },
  { currency: "PHP", regions: "PH", budget: 95000, price: 83000 },
  { currency: "ILS", regions: "IL PS", budget: 6000, price: 5200 },
  { currency: "AED", regions: "AE", budget: 6000, price: 5200 },
  { currency: "SAR", regions: "SA", budget: 6000, price: 5200 },
  { currency: "QAR", regions: "QA", budget: 6000, price: 5200 },
  { currency: "KWD", regions: "KW", budget: 500, price: 440 },
  { currency: "BHD", regions: "BH", budget: 600, price: 520 },
  { currency: "OMR", regions: "OM", budget: 650, price: 570 },
  { currency: "ZAR", regions: "ZA", budget: 30000, price: 26000 },
  { currency: "EGP", regions: "EG", budget: 80000, price: 70000 },
  { currency: "MAD", regions: "MA EH", budget: 16000, price: 14000 },
  { currency: "NGN", regions: "NG", budget: 2500000, price: 2200000 },
  { currency: "KES", regions: "KE", budget: 210000, price: 185000 },
  { currency: "BRL", regions: "BR", budget: 9000, price: 7800 },
  { currency: "MXN", regions: "MX", budget: 32000, price: 28000 },
  { currency: "ARS", regions: "AR", budget: 2000000, price: 1750000 },
  { currency: "CLP", regions: "CL", budget: 1500000, price: 1300000 },
  { currency: "COP", regions: "CO", budget: 6500000, price: 5700000 },
  { currency: "PEN", regions: "PE", budget: 6000, price: 5200 },
];

/** @param {readonly string[]} languages @param {string | null} [country] */
export function exampleCurrency(languages, country = exampleCountry(languages)) {
  const locales = languages.flatMap((language) => {
    try {
      return [new Intl.Locale(language)];
    } catch {
      return [];
    }
  });
  // Prefer an explicit region over guessing one from a language such as "en".
  const region = country;
  const example = examples.find((entry) => entry.regions.split(" ").includes(region ?? ""));
  // Keep the original GBP example when a region has no curated local example.
  const { currency, budget, price } = example ?? { currency: "GBP", budget: 1250, price: 1100 };
  const formatter = new Intl.NumberFormat(locales[0]?.toString() ?? "en-GB", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return {
    currency,
    budget: formatter.format(budget),
    price: formatter.format(price),
    saving: formatter.format(budget - price),
  };
}

/**
 * @param {Document} page
 * @param {readonly string[]} languages
 * @param {string | null} [country]
 */
export function localiseCurrency(page, languages, country = exampleCountry(languages)) {
  const amounts = exampleCurrency(languages, country);
  for (const element of page.querySelectorAll("[data-example-amount]")) {
    const key = element.getAttribute("data-example-amount");
    if (key === "budget" || key === "price" || key === "saving") {
      element.textContent = amounts[key];
    }
  }
}

if (typeof document !== "undefined") {
  const update = () => localiseCurrency(document, navigator.languages, currentExampleCountry());
  update();
  window.addEventListener("languagechange", update);
  window.addEventListener("goodfinds-country-change", (event) => {
    if (event instanceof CustomEvent && typeof event.detail === "string")
      localiseCurrency(
        document,
        navigator.languages,
        event.detail === "other" ? null : event.detail,
      );
  });
}
