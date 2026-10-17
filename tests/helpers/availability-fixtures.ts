import { marketplaceSchema } from "@goodfinds/contracts/integrations";
import type { Marketplace } from "@goodfinds/contracts/integrations";

// Fictional listings covering every supported source's canonical identity format.
const identities = {
  facebook_marketplace: ["12345", "https://www.facebook.com/marketplace/item/12345"],
  ebay: ["12345", "https://www.ebay.co.uk/itm/12345"],
  vinted: ["12345", "https://www.vinted.co.uk/items/12345-fixture"],
  gumtree: ["12345", "https://www.gumtree.com/p/for-sale/fixture/12345"],
  autotrader: ["12345", "https://www.autotrader.co.uk/car-details/12345"],
  craigslist: ["12345", "https://chicago.craigslist.org/chc/sss/d/fixture/12345.html"],
  cargurus: ["12345", "https://www.cargurus.com/details/12345"],
  poshmark: [
    "6577c0f3ac1f7629f1c445fe",
    "https://poshmark.com/listing/fixture-6577c0f3ac1f7629f1c445fe",
  ],
  depop: ["seller-fixture-item", "https://www.depop.com/products/seller-fixture-item"],
  mercari: ["m12345", "https://www.mercari.com/us/item/m12345"],
  cars_com: [
    "92353b66-069f-47b0-a250-20a82f4ecd40",
    "https://www.cars.com/vehicledetail/92353b66-069f-47b0-a250-20a82f4ecd40",
  ],
  autotrader_us: ["12345", "https://www.autotrader.com/cars-for-sale/vehicle/12345"],
} as const satisfies Record<Marketplace, readonly [string, string]>;

export const availabilityIdentities = (product: string) =>
  marketplaceSchema.options.map((source) => {
    const [listing_id, url] = identities[source];
    return { source, provenance: "manual" as const, listing_id, url, product };
  });
