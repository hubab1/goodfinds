# Regional coverage

Goodfinds resolves shopping country, language, currency and collection/delivery preferences separately. An available regional route identifies a supported site in the code; account access, delivery eligibility and live integration behavior still need verification. Read [marketplace validation](marketplace-validation.md) for those boundaries.

## Preferences and saved searches

Explicit choices take precedence over saved regional preferences. Saved location and optional client hints can help resolve the shopping country; the resolved country can supply a default currency. Setup returns the source of each choice. Language-only hints and timezones do not establish a shopping country, and hints are never saved as a confirmed collection origin.

An explicit currency stays unchanged when the buyer travels. Templates use the resolved currency and its minor units; unresolved currency requires clarification before selecting a template. Goodfinds does not convert between currencies, and its interface text remains English.

New searches save their regional choices. Existing searches and drafts preserve their currency, budget and marketplace selections when preferences change. Recommendations consider country, item category, collection/delivery preference and disabled sources. The requested product model remains unchanged: a vehicle model's country of origin does not select the shopping market.

## Marketplace routes

The [regional registry](../packages/contracts/src/regional-data.ts) is the source of supported countries, domains and recommendation order. [Regional resolution](../packages/contracts/src/regional.ts) and the [native regional module](../apps/server/src/regional.rs) apply those rules.

eBay and Vinted have country-specific routes. Facebook uses its shared domain and requires checking the site's actual location. Craigslist supports US and Canadian city sites; Gumtree and Auto Trader use their UK routes. CarGurus, Cars.com, Autotrader US, Poshmark and Mercari use US routes, while Depop supports the US and UK. Auto Trader UK and Autotrader US have separate marketplace identities. CarGurus UK and Mercari Japan are outside the configured scope.

New briefs reject an explicitly selected marketplace without a route in the chosen country. An unavailable route stays explicit rather than falling back to a UK site. Delivery eligibility, account access and total costs remain listing-level evidence.

## Website examples

The website uses the same registry and regional vehicle priorities as the plugin. Its country selector overrides the browser's language-region hint and saves that choice on the device. Unknown countries produce neutral examples; countries without a supported dedicated vehicle source omit the vehicle example. Website examples do not alter the plugin's saved preferences or replace products in real buying requests.

## Contributing

Update the shared registry when changing coverage, then regenerate the website data with `bun scripts/generate-website-regions.ts`. Preserve explicit and saved preferences when changing resolution rules. Run `bun run test:prepare`, then the regional setup and website tests:

```sh
bun test --timeout 30000 ./tests/regional-setup.test.ts ./tests/website-regions.test.ts
```

The [regional marketplace test procedure](us-marketplace-validation.md) covers listing identity, import, media and live acceptance checks. A configured domain or passing fixture does not establish live browser support.
