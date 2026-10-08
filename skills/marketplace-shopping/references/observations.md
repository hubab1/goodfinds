# Observation contract

The helper accepts a JSON array of normalized observations. Extract numbers and classifications from listing evidence; preserve uncertain fields as null or `unknown`. Example fixtures are in `../assets/demo-listings.json`.

For MCP imports, apply the request-ID and retry rules in [tool contracts](tool-contracts.md). Each batch has its own durable evaluateObservations receipt.

## Discovery, verification and complete setup costs

Pass `run_id` beside observations to associate an import with a resumable run. `collection_stage: discovery` records visible search-card facts without claiming a detailed review; it never triggers a deal alert. `collection_stage: verification` records the inspected detail page and gallery. A later discovery sighting retains earlier detailed evidence but makes the item provisional until checked again. Every import uses the current observation schema advertised by the tool.

Optional `verification_checks` contain `{id, label, question, state, evidence}`. States are confirmed, missing, unknown or conflicting. Confirmed/missing require a source excerpt or exact photo reference. An accessory absent from a photo is unknown, not missing. Unknown and conflicting checks produce seller questions. Importing a seller confirmation needs its exact statement; an ambiguous “yes” does not resolve every check.

Optional `setup_costs` contain `{label, price_minor, currency, basis, evidence}` for required extras beyond the known purchase/delivery/fees total. Basis is observed, estimate or unknown. Known amounts need a source; unknown amounts are null. Do not charge an assumed replacement for an unknown accessory. Setup totals show their basis; estimates and cross-currency/unknown extras need verification before a within-budget alert. Avoid double-counting bundled parts, delivery, fees or an integrated grinder. Price peers still use equivalent asking prices.

Each observation has these fields:

| Field                                               | Meaning                                                                                                                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `source`                                            | `facebook_marketplace`, `ebay`, `vinted`, `gumtree`, `craigslist`, or `autotrader` (UK)                                                                                                                            |
| `provenance`                                        | `manual` for supplied or user-requested browser observations, or `synthetic` for a demo                                                                                                                            |
| `collection_method`, `observed_at`                  | `user_requested_browser` for listings inspected in the signed-in browser, plus an ISO timestamp with timezone                                                                                                      |
| `listing_id`, `url`                                 | Stable listing ID and canonical item URL                                                                                                                                                                           |
| `title`, `description`                              | Observed listing text                                                                                                                                                                                              |
| `seller_name`, `seller_profile_url`                 | Seller information shown with the listing; missing information stays null                                                                                                                                          |
| `photos`                                            | Array of cached `media_id`, positive image `position` and evidence-based `caption`; image bytes stay outside the package                                                                                           |
| `videos`                                            | Array of cached video `media_id`, positive video `position`, `caption`, optional cached image `poster_media_id`; MP4/WebM bytes remain separate from state                                                         |
| `video_review`                                      | `total_videos`, unique `reviewed_positions`, `complete`, optional notes; every clip must be watched for a complete review                                                                                          |
| `media_capture`                                     | `status: complete                                                                                                                                                                                                  | partial | unavailable`, observed `expected_photos`/`expected_videos`, optional failure notes; complete requires every file saved |
| `image_review`                                      | `total_images`, unique `reviewed_positions`, `complete`, and optional `notes`; complete means every image was inspected                                                                                            |
| `seller_avatar_media_id`                            | Cached seller profile image ID, or null when unavailable                                                                                                                                                           |
| `seller_has_profile_image`                          | true for a visible custom image, false for a visible default placeholder, null when not established                                                                                                                |
| `seller_account_joined_at`                          | Facebook join date as `YYYY-MM-DD` or the visible year as `YYYY`; never invent the month/day                                                                                                                       |
| `seller_metadata_checked_at`                        | Timezone-aware check timestamp; include source excerpts for join date and image presence in `evidence`                                                                                                             |
| `seller_listing_count`, `seller_listing_count_text` | Current Marketplace listing count across categories and original wording; unavailable counts stay null, never zero                                                                                                 |
| `seller_listing_count_precision`                    | `exact`, `approximate` or `lower_bound` when a numeric count is present; otherwise null                                                                                                                            |
| `seller_listings_checked_at`                        | Timezone-aware check timestamp; include the observed `seller_profile_url` and a `seller_listing_count` excerpt in `evidence`                                                                                       |
| `seller_inventory_review`                           | Optional inspected similar-item sample with profile source, category, item kind, check time, evidence and distinct active item links; see [seller inventory context](listing-evidence.md#seller-inventory-context) |
| `seller_public_profile_url`                         | Facebook profile link observed through the seller's Marketplace profile; separate from the Marketplace seller link                                                                                                 |
| `seller_friend_count`, `seller_friend_count_text`   | Visible aggregate friend total and original wording; hidden totals stay null, never zero                                                                                                                           |
| `seller_friend_count_precision`                     | `exact`, `approximate` or `lower_bound` when a numeric count is present; otherwise null                                                                                                                            |
| `seller_profile_checked_at`, `seller_profile_notes` | Timezone-aware profile check and relevant visible context or availability limitations; include a `seller_friend_count` excerpt in `evidence`                                                                       |
| `price_minor`, `currency`, `price_kind`             | Full outright asking price in integer minor units, currency, and `asking`; finance, bid, deposit and placeholder amounts are ignored                                                                               |
| `product`                                           | The saved definition’s category, such as `macbook_pro`, `mac_mini` or `rental`                                                                                                                                     |
| `chip`                                              | Full chip name such as `M3 Pro`, not merely a generation                                                                                                                                                           |
| `ram_gb`, `ssd_gb`                                  | Memory and internal SSD capacities; 1 TB is 1000 GB for matching                                                                                                                                                   |
| `screen_inches`                                     | Required for comparing MacBook Pro listings; null for Mac mini                                                                                                                                                     |
| `condition`                                         | `good`, `excellent`, `like_new`, `fair`, `poor`, `broken`, `spares`, or `unknown`                                                                                                                                  |
| `item_state`                                        | `new`, `used`, `refurbished`, or `unknown`                                                                                                                                                                         |
| `functional`                                        | true only with explicit working-condition evidence, false for non-functional items, null when uncertain                                                                                                            |
| `availability`                                      | `active`, `reserved`, `sold`, `out_of_stock`, `ended_unsold`, `expired`, `removed`, `unknown_unavailable`, or `unknown`                                                                                            |
| `drive_minutes`, `drive_origin`                     | Estimated one-way route time and the exact configured origin; include `drive_latitude` and `drive_longitude` when the confirmed origin has coordinates                                                             |
| `travel_source`, `travel_checked_at`                | Route evidence and its timestamp; synthetic examples identify themselves                                                                                                                                           |
| `evidence`                                          | Object containing excerpts for `chip`, `ram_gb`, `ssd_gb`, `condition`, `functional`, and laptop `screen_inches`                                                                                                   |

## Price basis and payment methods

“Cash price” means the full outright purchase price, regardless of whether the seller accepts bank transfer, card or physical cash. It is not a payment-method restriction. Do not collect monthly finance payments, instalments, APR or finance terms for comparison. Never derive a purchase price by multiplying payments. Finance-only sightings remain useful for listing history but have no comparable price and cannot trigger a deal alert. Bids, deposits, placeholders and zero-price advertisements also stay out of purchase-price comparisons.

Use `price_minor` with `price_kind: asking` for an evidenced full price. If a page presents finance beside the outright price, supply `cash_price_minor` and the exact source excerpt under `evidence.cash_price_minor`; this overrides the non-purchase amount. For purchases, `price_period` is `once`. A monthly/weekly purchase quote cannot enter a comparison even if mistakenly labelled `asking`. Existing weekly/monthly rental periods remain separate and supported.

Every observation containing a numeric `price_minor` must include its `price_kind`, including description, seller and detail-page updates after an earlier discovery import. For a visible £1,250 outright price, send `price_minor: 125000`, `currency: GBP`, `price_kind: asking` and a price excerpt together. The importer rejects a numeric price with no basis; correct that payload and retry rather than deleting the price. Read back the stored price and currency after importing. Use a separate media attachment for media-only repairs.

Optional `displayed_previous_price_minor` is the seller's displayed previous outright price, not a historical price observation. Record shipping, buyer fees and tax as `shipping_minor`, `buyer_fee_minor` and `tax_minor`, with excerpts. Unknown costs stay null. Set `costs_complete: true` only when every component is known, including explicit zero amounts; then the helper derives `total_cash_cost_minor`. This displayed total supplements the full-price comparison; the current deal rule still compares equivalent asking prices.

## Publication, availability and observation history

Always separate the time a page was checked (`observed_at`) from the original ad publication. Preserve the raw date wording in `publication.raw_text`, with `precision: exact|bounded|approximate|unknown` and `kind: published|updated|renewed|unknown`. An update or renewal does not establish original publication. Do not turn “three days ago” into an invented exact timestamp.

An exact timestamp requires equal `earliest_at` and `latest_at`, a timezone and source `evidence`. A bounded publication requires both endpoints and evidence establishing the range. Both must precede the observation. Otherwise retain only the approximate wording. The earliest evidenced original publication is preserved across later updates; all supplied snapshots remain retained.

`availability_text` preserves the platform wording. `availability` records its supported normalized meaning. A sold label is a seller/platform status, not proof of a completed transaction or final sale price. Out of stock, reservation, expiry and removal stay distinct. Reopening is allowed. A search miss never changes listing availability.

Use `check_outcome: success|login_required|forbidden|rate_limited|network_error|parser_error|not_found|not_inspected`. A failed direct check can use a minimal record containing source, provenance, listing ID, canonical URL, observation time and outcome. It leaves prior successfully observed details in history, records the failed attempt and withholds current-availability and price-comparison eligibility. Do not set `sold` after an error, hidden item or missing search result. Missing details in a new successful observation are unknown; they do not silently inherit prior seller verification.

The helper stores immutable observation payloads and rebuildable events for first seen, price changes, status changes, content changes, relationships and failed checks. Events retain observation time and change bounds; import time remains available separately. Active duration is the first observed availability episode, with lower/upper duration bounds and unfinished periods. It is not an inferred transaction time. `inventory_type: multiple_units` excludes stock listings from individual-item lifetime summaries; `single_item` and `unknown` are also supported. `quantity` must be positive.

## Shared fields and identity

Use stable numeric live item IDs and canonical item URLs from the declared platform. Facebook keys retain their existing identity; other sources have separate namespaces, so equal numeric IDs do not collide. Supported item paths are Facebook `/marketplace/item/ID/`, eBay `/itm/ID` or `/itm/slug/ID`, Vinted `/items/ID-slug`, Gumtree `/p/category/slug/ID`, regional Craigslist item paths ending `/ID.html`, and UK Auto Trader `/car-details/ID`. Query strings and tracking fragments are stripped. Synthetic records use `example.invalid` in their isolated workspace. These mappings accept supplied observations; they do not create unattended platform collectors.

Optional shared context includes `country`, `category_id`, `category_path`, `discovery_surface`, `seller_id`, `seller_type`, `bundle_type`, `location_precision`, plus bounded JSON objects `seller`, `logistics`, `interest`, and `terms`. Preserve labelled ratings/review counts, shipping and collection arrangements, negotiability, accessories, warranty or visible interest counts with source wording. Unsupported or hidden values remain unknown. Never treat a platform popularity counter as a direct measure of buyer demand.

`field_evidence` maps each field to an object with `state: observed|inferred|unknown|unsupported|not_inspected|conflicting` and supporting context, such as raw text, source reference and precision. Conflicting evidence requires review. Use explicit `relationships` objects with `source`, `listing_id`, `kind: relist_of|cross_post_of|duplicate_of`, `confidence: confirmed|probable`, and `evidence`. Only confirmed identity links collapse observations into one item for statistics. Similar titles/photos alone are probable and stay visible. Distinct specifications, bundles, seller types, quantities, condition, currencies and periods stay separate in comparison cohorts.

### Platform interpretation

These distinctions guide evidence collection; they do not establish a working collector, buyer sign-in or API entitlement. Recheck the selected region, listing and account when a field matters. Store the inventory's source separately from `discovery_surface`; appearing through another marketplace is not itself a new item or a confirmed cross-post relationship.

| Platform       | Interpretation and source                                                                                                                                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| eBay           | `itemOriginDate` is first availability, while `itemCreationDate` is listing creation; they can differ. Keep the exact field meaning. Bids, reference prices and end dates do not establish a completed sale. [Browse release notes](https://developer.ebay.com/api-docs/buy/browse/static/release-notes.html)                                     |
| Vinted         | A reservation can hide an unsold item from other members. Do not infer a sale from disappearance. Item price, Buyer Protection and shipping remain separate cost components. [Reservation help](https://www.vinted.co.uk/help/59-reserving-an-item)                                                                                               |
| Gumtree        | Expiry and deletion can remove unsold ads. Offer presets are proposed offers, not earlier asking prices. [Ad management](https://www.gumtree.com/info/safety/p/advice-guides/repost-delete-edit-your-gumtree-ad/)                                                                                                                                 |
| Craigslist     | Renewal can move an existing post to the top; that recency is not original publication. Separate wanted requests and nominal prices from sale inventory. [Renewal help](https://www.craigslist.org/about/help/posting/modify/renew)                                                                                                               |
| Auto Trader UK | The specification panel can describe a usual model rather than the actual vehicle. Verify consequential details from listing-specific evidence; keep platform valuations separate from observed asking prices. [Specification caveat](https://help.autotrader.co.uk/hc/en-gb/articles/14340113739293-Where-can-I-find-the-vehicle-specifications) |

## Search coverage and market statistics

Pass optional `search_coverage` beside `observations` to `import_goodfinds_listing_observations`. The standalone helper accepts the same JSON array with `--search-coverage /absolute/path/search-coverage.json`. A coverage record requires the saved `search_id`, source, query, filters object, sort, timezone-aware `started_at` and `finished_at`, `status: success|partial|failed`, and `pagination_complete`. `result_count` and `inspected_count` can be unknown/null; do not replace an unknown total with zero. Notes may explain limits. A zero-observation evaluation can still record a failed search.

```json
{
  "source": "facebook_marketplace",
  "search_id": "my-camera-search",
  "query": "Sony A7 III",
  "filters": { "area": "Birmingham", "radius_km": 40 },
  "sort": "newest",
  "started_at": "2026-10-04T10:00:00+00:00",
  "finished_at": "2026-10-04T10:10:00+00:00",
  "status": "partial",
  "pagination_complete": false,
  "result_count": null,
  "inspected_count": 4,
  "notes": "Inspected four relevant ads; the remaining result pages were not traversed."
}
```

Never label a short or ranked first page as complete inventory. Frequency uses original publication bounds inside intervals between repeated successful, complete checks with unchanged query/filter/sort/search definitions. Gaps over twice the saved check interval, failed runs and changed search definitions break coverage. Initial backlog and confirmed relists are excluded from new arrivals. Unknown publication evidence for new observations suppresses the rate. Combined platforms do not add platform-days into elapsed market days. Report an observed sample, its coverage and sample size; unseen short-lived listings can still be missed. Historical imports without coverage cannot establish a market frequency or expected waiting time.

Completed availability periods are summarized separately from unfinished periods and marked-sold counts. Their median bounds are a description of observed completed periods, not the typical time to sell: removals/reservations can end a period, and completed-only samples favor shorter lifetimes. The current implementation does not estimate a censored survival curve or a buyer's waiting-time probability.

The statistical basis is the distinction between exact events, unfinished observation periods and events known only within an interval. Goodfinds therefore retains bounds and separate outcomes instead of inventing sale dates. See [NIST's censoring guide](https://www.itl.nist.gov/div898/handbook/apr/section1/apr131.htm). Applying a survival estimator later would require an appropriate method and justified treatment of unknown or competing outcomes.

## Metric-specific quality

Every listing has separate eligibility and reasons for arrival rates, current stock, price baselines, durations and deal alerts. `quality_policy` defaults are `max_check_age_hours: 72`, `minimum_outlier_peers: 20`, and `outlier_z: 3.5`. These are configuration defaults, not empirically calibrated fraud or sale thresholds. Failed/stale availability, missing full price and conflicting evidence block the affected uses, while history stays retained. The saved search's required evidence and the existing combined seller/price review also gate the price pool and alerts.

A robust median/MAD check flags unusual full prices only among equivalent distinct peers. Zero spread has no finite deviation score. Long advertised age is flagged above the equivalent observed sample's 95th percentile when enough original publication evidence exists. Cheapness or age alone never proves fraud or an unremoved sale and never deletes a listing. Keep those flags as context; combined suspicious-price and seller evidence holds a candidate for review and excludes it from automatic comparisons/alerts. The ordinary arithmetic average remains the deal rule; the panel's median is an additional descriptive statistic.

[NIST's outlier guidance](https://www.itl.nist.gov/div898/handbook/eda/section3/eda35h.htm) describes the modified z-score cutoff of 3.5 as a convention for labeling potential outliers. Its meaning depends on the cohort distribution; it is not a marketplace fraud detector. The minimum peer count and age percentile remain product defaults that need evaluation with representative observations.

## Generated search attributes

Category-specific facts belong in `attributes`, a bounded object of scalar values or string arrays. Match the definition's `match.attribute` and `comparison_attributes` names. For each required criterion, put a source excerpt under that same name in `evidence`. Record unknown values as null. Attribute values may not conflict with top-level fields.

For a rental, an example is `attributes: {"area": "Birmingham", "accommodation": "whole_property", "property_type": "flat", "bedrooms": 2, "floor": "ground"}`. Accommodation records the whole-property/private-room/shared-room arrangement once. Record `price_period` as `month` or `week` alongside the full rent in integer pence. A different or unknown period requires review. Whole-property bedroom requirements are hidden for room searches. Optional null answers impose no filter. Preferred criteria are reported separately from must-have requirements.

A whole-number range matched to `seller_listing_count` can limit candidates in any category. It uses the top-level count, precision, seller profile source, evidence and a check within 30 days. Unknown or approximate totals require review; lower bounds establish only constraints their possible range proves. These limits do not narrow price-comparison peers. Do not collect last-active information.

The `chip_generation` attribute is derived from a recorded full M-chip name, with evidence stored under `chip`. Image review, availability, full asking price and currency checks apply across categories. Working condition and screen-size checks apply to the laptop categories. Driving-time evidence is required when that search includes a hard driving-time criterion.

The helper checks explicit structured fields and evidence presence. It cannot verify that an excerpt is truthful, detect every scam, read a browser, calculate a route, or establish that every advertised hardware configuration exists. The collector or reviewing user must resolve those uncertainties before import. An unknown specification or condition is excluded from deal alerts and shown as requiring review.

Real candidates also require a complete image review and, when videos are present, a complete video review. Saving a file alone is not inspection. Cache downloaded photos and videos with `cache_goodfinds_media` and seller images with `cache_goodfinds_images` before importing IDs. The MCP import validates local media references and types. Save visible thumbnails during discovery and follow with gallery capture for all saved listings, including those outside the shortlist. Later observations that omit media arrays retain saved media; fresh verification facts do not silently inherit past review coverage. See [listing evidence](listing-evidence.md) for model lookup, gallery inspection and seller/price credibility rules.

Keep complete, correctly configured items separate from accessories, bundles, deposits, broken items, and ads whose advertised price is not the full asking price. Validate suspicious hardware descriptions against Apple's model specifications. For example, the 2023 16-inch M3 Pro MacBook Pro can have 36 GB memory, which meets a 32 GB minimum; the 2024 M4 Mac mini supports 32 GB, while its M4 Pro configuration uses 24, 48, or 64 GB.

Sources checked on 4 October 2026:

- [Apple MacBook Pro specifications](https://support.apple.com/en-gb/117737)
- [Apple Mac mini specifications](https://support.apple.com/en-gb/121555)
- [ChatGPT browser profiles](https://learn.chatgpt.com/codex/browser?surface=app)
- [Scheduled tasks](https://learn.chatgpt.com/codex/automations)
- [Meta's explanation of automated collection](https://about.fb.com/news/2021/04/how-we-combat-scraping/)
