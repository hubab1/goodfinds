import regions from "./marketplace-regions.json" with { type: "json" };

/** @typedef {{id: string, name: string, url: string}} Market */
/** @type {Record<string, {marketplaces: Market[], vehicle: string[], fashion: string[]}>} */
export const marketplaceRegions = regions;

const icons = {
  facebook_marketplace: "facebook",
  ebay: "ebay",
  vinted: "vinted",
  gumtree: "gumtree",
  autotrader: "autotrader",
  craigslist: "craigslist",
};
/** @typedef {{slot: string, marketplace: string, name: string, icon: string}} Example */
/** @param {string | null} country @returns {Example[]} */
export function marketplaceExamples(country) {
  const region = country ? marketplaceRegions[country] : undefined;
  if (!region)
    return [{ slot: "aeron", marketplace: "generic", name: "Local marketplaces", icon: "store" }];
  const sources = new Map(region.marketplaces.map((market) => [market.id, market]));
  /** @param {string} slot @param {string | undefined} id @returns {Example[]} */
  const pick = (slot, id) => {
    const market = id ? sources.get(id) : undefined;
    return market
      ? [
          {
            slot,
            marketplace: market.id,
            name: market.name,
            icon: /** @type {Record<string, string>} */ (icons)[market.id] ?? "store",
          },
        ]
      : [];
  };
  const vehicle = region.vehicle.find((id) =>
    ["autotrader", "cargurus", "cars_com", "autotrader_us"].includes(id),
  );
  return [
    ...pick("aeron", "facebook_marketplace"),
    ...pick("x100v", "ebay"),
    ...pick(
      "beta",
      region.fashion.find((id) => ["vinted", "poshmark", "depop"].includes(id)),
    ),
    ...pick("brompton", country === "GB" ? "gumtree" : "craigslist"),
    ...pick("vehicle", vehicle),
    ...pick("stratocaster", "mercari"),
  ];
}

/** @param {HTMLElement} carousel @param {string | null} country */
export function localiseMarketplaces(carousel, country) {
  const examples = marketplaceExamples(country);
  const american = country === "US";
  const vehicle =
    country === "GB"
      ? {
          product: "2018 Volkswagen Golf GTI",
          heading: "A Golf GTI.",
          spec: "2018",
          trim: "GTI",
          transmission: "DSG automatic",
          image: "golf-gti",
          alt: "Illustration of a red Volkswagen Golf GTI hatchback",
          prompt: "“Find me a 2018 Volkswagen Golf GTI, DSG automatic, with full service history.”",
        }
      : {
          product: "2019 Toyota Camry",
          heading: "A 2019 Camry.",
          spec: "2019",
          trim: "Hybrid",
          transmission: "Automatic",
          image: "camry",
          alt: "Illustration of a red Toyota Camry Hybrid sedan",
          prompt: "“Find me a 2019 Toyota Camry Hybrid, automatic, with maintenance records.”",
        };
  const vehicleSlide = carousel.querySelector('[data-example-slot="vehicle"].marketplace-slide');
  if (vehicleSlide) {
    const heading = vehicleSlide.querySelector("h3");
    if (heading)
      heading.replaceChildren(vehicle.heading, document.createElement("br"), "Exactly your spec.");
    vehicleSlide.querySelectorAll(".marketplace-filters li").forEach((item, index) => {
      item.textContent = [vehicle.spec, vehicle.trim, vehicle.transmission][index] ?? "";
    });
    const photo = vehicleSlide.querySelector("img");
    if (photo) {
      photo.src = `media/products/${vehicle.image}.webp`;
      photo.alt = vehicle.alt;
    }
    const prompt = vehicleSlide.querySelector("blockquote");
    if (prompt) prompt.textContent = vehicle.prompt;
    const product = carousel.querySelector('[data-example-slot="vehicle"] .marketplace-product');
    if (product) product.textContent = vehicle.product;
  }
  for (const element of carousel.querySelectorAll("[data-example-slot]")) {
    if (!(element instanceof HTMLElement)) continue;
    const index = examples.findIndex((example) => example.slot === element.dataset["exampleSlot"]);
    const example = examples[index];
    element.hidden = !example;
    element.dataset["regionVisible"] = String(Boolean(example));
    if (!example) continue;
    if (element.matches(".marketplace-slide")) {
      element.dataset["marketplaceName"] = example.name;
      element.setAttribute("aria-label", `${index + 1} of ${examples.length}: ${example.name}`);
      const count = element.querySelector(".marketplace-count");
      if (count) count.textContent = `${index + 1} / ${examples.length}`;
    } else {
      const button = element.querySelector("button");
      if (button) button.dataset["marketplace"] = example.marketplace;
      const name = element.querySelector(".marketplace-name");
      if (name) name.textContent = example.name;
      const icon = element.querySelector("img");
      if (icon)
        icon.src =
          `media/marketplaces/${example.icon}.` + (example.icon === "store" ? "svg" : "png");
    }
  }
  const collection = american ? "Local pickup" : "Local collection";
  const colour = american ? "color" : "colour";
  const copies = [
    ["#example-aeron .marketplace-meta > span", `Furniture · ${collection}`],
    [
      "#example-aeron .marketplace-prompt",
      `“Find me a size B Aeron with adjustable arms, ${country === "US" || country === "GB" ? "within 20 miles" : country ? "within 30 km" : "nearby"}.”`,
    ],
    [
      "#example-aeron .marketplace-reason",
      `The right size, working adjustments, and a seller close enough for ${american ? "pickup" : "collection"}. Plenty to be particular about.`,
    ],
    [
      "#example-beta .marketplace-reason",
      `Size, ${colour}, and condition make the match. A precise brief gives each new listing something useful to measure up to.`,
    ],
    ["#example-brompton .marketplace-meta > span", `Cycling · ${collection}`],
    ["#example-brompton .marketplace-filters li:nth-child(2)", american ? "Fenders" : "Mudguards"],
    ["#example-brompton .marketplace-filters li:nth-child(3)", collection],
    [
      "#example-brompton .marketplace-prompt",
      `“Find me a six-speed Brompton C Line with ${american ? "fenders" : "mudguards"}, nearby, with its condition and service history described.”`,
    ],
  ];
  for (const [selector, copy] of copies) {
    if (!selector || !copy) continue;
    const element = carousel.querySelector(selector);
    if (element) element.textContent = copy;
  }
  const jacketTitle = carousel.querySelector("#example-beta h3");
  if (jacketTitle)
    jacketTitle.replaceChildren(
      "An Arc’teryx Beta.",
      document.createElement("br"),
      `Your ${colour}. Your size.`,
    );
  const list = carousel.querySelector(".marketplace-list");
  if (list instanceof HTMLElement) list.hidden = false;
  return examples;
}
