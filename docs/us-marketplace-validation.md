# Regional marketplace validation

Added CarGurus US (`cargurus`), Poshmark US (`poshmark`), Depop US/UK (`depop`), Mercari US (`mercari`), Cars.com US (`cars_com`) and Autotrader US (`autotrader_us`). CarGurus UK is deliberately excluded. Existing Auto Trader UK keeps `autotrader`.

Local usage drives recommendations, independently of website availability. US fashion defaults prioritise Poshmark, Depop, Mercari and eBay for delivery; US vehicle defaults include the three US vehicle sites. Depop joins the UK fashion defaults. Existing explicit/saved marketplace choices and currencies survive preference changes. Vinted US remains a manually selectable existing route, outside the US fashion defaults. This expansion adds no other regional brands.

## Repeatable test set

[Machine-readable cases](../tests/fixtures/new-marketplaces.json) provide one listing per source/region, public identity, query, category, price basis, location, description/specification sample and gallery total. [The automated tests](../tests/new-marketplaces.test.ts) exercise the native implementation. Fixtures are snapshots for deterministic regression, not current availability assertions. If a live listing disappears, record it as unavailable and select one fresh result through the site's UI; do not silently alter the historical fixture.

Run `bun run test:prepare`, then:

```sh
bun test --timeout 30000 ./tests/new-marketplaces.test.ts ./tests/regional-setup.test.ts ./tests/marketplace-actions.test.ts ./tests/marketplace-browsing.test.ts ./tests/media-receipts.test.ts
```

For each source and region, use an isolated development workspace and a fictional buying brief. Verify country, native filters, listing identity, asking price and cost breakdown. Capture the observed gallery, import the observation, and compare native readback with the source evidence. Record search, detail, media and import duration separately, together with failures, recovery and coverage gaps. Seller contact and purchases require a separate explicitly authorized test.

Acceptance checks for every case:

1. Search reaches relevant results with the intended region, category and fulfilment. Explicit currencies and saved preferences win over browser hints.
2. Source/URL/ID agree; wrong hosts, mismatched IDs and non-item pages are rejected. CarGurus UK and Mercari Japan remain outside scope. Both observed Autotrader US URL forms retain the same listing key.
3. Current item price is distinct from original prices, monthly payments, delivery, buyer fees and taxes. Unknown costs stay unknown; no double-counting included fees.
4. Description, location, seller and category attributes survive readback, including null location. Seller sold/review totals are not current inventory.
5. Main gallery slots retain order. Thumbnails, recommendations, dealer photos and ads are excluded. AVIF is accepted by content type, not extension. Partial media capture and missing videos remain explicit.
6. A later fact-only observation preserves media. Caching does not set visual review complete. No seller action or monitoring is triggered by development verification.

Existing-source contact/browser regressions now exercise all 12 marketplace IDs in both browser routes. The existing locale suite continues to cover explicit/saved currency precedence and saved-source preservation. Native AVIF tests reject truncated/misleading container headers.

## Live coverage limits

Public search, detail inspection and media import have been exercised for these routes. Browser challenges, consent controls, changing filters and incomplete galleries can still prevent completion. Full media capture does not establish visual review or the truth of seller claims. Signed-in contact, native-offer submission and unattended monitoring require separate live validation. Follow the [marketplace acceptance procedures](marketplace-validation.md#remaining-live-acceptance-work).
