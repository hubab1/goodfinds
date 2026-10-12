# Marketplace navigation

Read the section for the current marketplace after the shared search workflow. These are navigation checks, not stable selectors or a promise that inventory matches its filters. Use the selected browser's current UI and documented APIs.

## Shared controls and recovery

Use a fresh DOM snapshot for locator names and iframe boundaries. Batch known inputs and their resulting state check. Extract relevant controls and result cards rather than repeatedly printing a whole catalogue. Accessibility names and DOM names can differ.

For Codex's `cua_repl`, selecting the browser exposes the tab's documented `playwright` API. Read those docs, then use `nodeRepl.write(await tab.playwright.domSnapshot())` for the first results page and after a failed accessibility click. `getAXState()` is an accessibility snapshot, not this DOM fallback. Build locators from that snapshot and read their `allTextContents()` or documented read-only DOM fields to collect card text in one call. Scrolling through screenshots to transcribe ordinary prices and locations adds work and can miss sibling fields; use visual inspection for information that actually needs it.

When accessibility text exposes only a card title, inspect the rendered card's DOM text and link/image elements before declaring its price, location or photos unavailable. Prefer the card container so sibling price/location text is retained. Keep unknowns when those fields are genuinely absent; missing text in one representation alone is insufficient evidence.

When a click reports a missing target, inspect the current DOM once and retarget the semantic control. For an iframe, use its observed frame selector and the control inside it. If that still fails, a supported screenshot-based click is one bounded alternative. Repeated failure across those methods is a browser interaction blocker; reopening the same tab or repeating the same index does not repair it. Preserve readable page evidence, record unapplied controls and continue other marketplaces. A dismissed consent dialog or applied filter needs a changed UI state.

This recovery budget covers the failed control, not each newly numbered accessibility target. Do not spend the whole multi-marketplace search retrying one site's consent or filters. Save its partial coverage before moving to the next requested marketplace.

A missing download button does not establish missing media support. Inspect the selected browser's documented media methods once. When available, an observed image locator's `downloadMedia` or the page-assets capability can capture rendered gallery media. A generic accessibility API summary is not the complete browser capability inventory. Follow listing-evidence for sequential downloads and honest gallery totals.

## eBay

Open the saved browser search link and verify Buy it now is selected. Submit a changed query through the current Search control; if its click leaves old results, press Enter in the observed search field once and check the new heading and cards. Keep purchase type and requested location/delivery filters through the broad query.

After changing postcode or collection radius, reopen the control and verify the persisted value and current result scope. If the site silently reverts after one corrected retry, mark that query partial with the actual applied location; continue other sources and verify individual pickup routes. A requested postcode is not evidence of an applied filter.

Read the exact model and selected variation on the detail page. Results can include other generations, Pro Max variants, accessories and promoted alternatives. Exclude these from exact-model matches. A bid, price range, monthly payment or accessory variation is not the full asking price of the requested phone. Record postage and collection availability separately; a UK result is not proof of nearby collection.

## Gumtree

Select the relevant category, then location and supported filters: Phones for a phone brief, Cars for a car brief. For vehicles, use available make/model, year and transmission controls rather than treating keywords as enforced requirements. Check these fields again on shortlisted detail pages.

Submitting another text query can reset the category to All Classifieds and radius to a site default. Recheck both immediately and restore the intended supported scope before collecting. A driving-time limit is not a mile radius. Count local results separately from extended-area recommendations. A card/detail price conflict remains a conflict until a current recheck resolves it.

## Facebook Marketplace

Confirm the displayed location before collecting cards; a saved Birmingham origin does not update a previously selected neighbouring town automatically. Use the location dialog and verify the applied label and radius. Apply a relevant vehicle/category filter when offered, and verify year and transmission in the listing itself. Plain search text does not enforce them.

Separate matching results from suggested or wider-area cards. A free, £1 or monthly-payment card has an unknown full asking price until the description establishes it. Preserve damage categories and differences between title, vehicle fields and description. A public listing or profile alone does not prove buyer sign-in. Record login walls or challenges and continue other platforms.

## AutoTrader

Use Cars search with the collection origin, then make, model, year-from/year-to and transmission filters. Verify visible selected controls and current result cards; the saved search link opens the search page but does not encode vehicle requirements. Results may include promoted or suggested alternatives.

Consent can be inside an iframe. Follow the shared bounded recovery above; an undismissed banner does not mean selected filters or readable cards vanished. If controls remain unusable, an exact observed result link can still be opened and inspected. Record unresolved filter application as partial coverage rather than guessing a broader search succeeded.

Use the full cash price, keeping finance payments and deposits separate. Check registration year, automatic transmission, body type and Cat N/Cat S disclosures on the detail page. Dealers can cross-list on Gumtree: compare registration/stock identity and current details before merging or presenting distinct cars. Read the actual gallery total; the hero image alone does not complete a large gallery review.

## Craigslist

Select the requested city or area and product category, then use the visible query and native filters. Cars expose year bounds and transmission; verify their applied chips alongside the ZIP/radius. Keep results under **more from nearby areas** separate from in-scope matches. Accessibility labels can remove spaces from the actual DOM label; use the current DOM name after a failed locator.

Regional subdomains can redirect to `www.craigslist.org/area/...`; follow the observed city/category links. Current canonical listings use `/view/d/<slug>/<22-character identifier>`. Use that final case-sensitive identifier as `listing_id`, and keep the separately displayed numeric **post id** in evidence. Legacy numeric `.html` links still use their numeric URL identifier. Preserve the observed canonical URL instead of constructing an old-format link from the post ID. A matching post ID is evidence of the same post across formats; do not count both as distinct inventory when that match is observed.
