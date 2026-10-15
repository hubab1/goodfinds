import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MARKETPLACES, marketHome } from "@goodfinds/contracts/integrations";
import { REGIONAL_MARKETS } from "@goodfinds/contracts/regional-data";
import { resolveRegion } from "@goodfinds/contracts/regional";
import { formatSource } from "./format-source.ts";

const countries = [
  ...new Set([
    ...Object.keys(REGIONAL_MARKETS.currencies),
    ...Object.values(REGIONAL_MARKETS.domains).flatMap(Object.keys),
  ]),
]
  .filter((country) => country !== "*")
  .toSorted();
const regions = Object.fromEntries(
  countries.map((country) => [
    country,
    {
      marketplaces: MARKETPLACES.flatMap((marketplace) => {
        const url = marketHome(marketplace.id, country);
        return url ? [{ id: marketplace.id, name: marketplace.name, url }] : [];
      }),
      vehicle: resolveRegion(
        {},
        { country, fulfilment: "collection" },
        {},
        "vehicle",
      ).marketplaces.map(({ id }) => id),
      fashion: resolveRegion(
        {},
        { country, fulfilment: "delivery" },
        {},
        "clothing",
      ).marketplaces.map(({ id }) => id),
    },
  ]),
);
const path = new URL("../website/marketplace-regions.json", import.meta.url);
const contents = await formatSource(fileURLToPath(path), JSON.stringify(regions));
if (process.argv.includes("--check")) {
  if ((await readFile(path, "utf8")) !== contents)
    throw new Error("Website regions are stale. Run bun scripts/generate-website-regions.ts");
} else {
  await writeFile(path, contents);
}
