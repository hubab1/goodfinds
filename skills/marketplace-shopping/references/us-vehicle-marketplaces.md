# US vehicle marketplaces

Read this for `cargurus`, `cars_com` or `autotrader_us`. These integrations are US-only. `autotrader` is the separate UK service. Use the search's saved country, currency, origin and collection/delivery preference. A retained site ZIP or browser locale does not override them. Do not add CarGurus UK or other regional brands merely because a domain exists.

When collecting or refreshing vehicle status, apply [availability evidence](availability-checks.md#marketplace-evidence). Every scheduled run rechecks saved listings through that guide before discovery; a contact or Check availability form alone does not confirm inventory.

## Search and inspect

Open the returned marketplace route once. Use the site's make/model, ZIP, radius, used/new, year, transmission, mileage and full-price filters. Verify the applied filters in the results heading/chips before collecting. A US public test ZIP is only for development tests; buying searches use the buyer's origin. For collection searches, turn off delivery/shippable inventory after the other filters settle, then verify it remains off. All three sites can enable it by default; navigation can reset it. Verify actual seller location and delivery terms per listing.

Cars.com's initial **Performing security verification** page can clear automatically. If it requests no interaction, allow one bounded wait of up to 30 seconds for the search controls, then inspect the resulting state. An interactive challenge or a verification page that remains is an access barrier; stop without bypassing it. Dismiss a visible cookie banner before retrying a blocked search submission. A filter can disappear or become disabled after narrowing the results: verify that required attribute on the selected listing and record that no native filter was applied.

Read a focused result card, take its observed detail URL, then inspect that listing once. Repeated titles are common; disambiguate using the observed href rather than clicking an ambiguous title. Wait for a detail heading or changed URL after navigation; an immediate snapshot can still show the old page. Sponsored results and external dealer ads are not automatically matches.

| Source        | Entry                                         | Canonical listing and `listing_id`                                                  |
| ------------- | --------------------------------------------- | ----------------------------------------------------------------------------------- |
| CarGurus US   | `https://www.cargurus.com/Cars/spt-used-cars` | `/details/459673970` → `459673970`                                                  |
| Cars.com US   | `https://www.cars.com/shopping/`              | `/vehicledetail/92353b66-069f-47b0-a250-20a82f4ecd40/` → the UUID                   |
| Autotrader US | `https://www.autotrader.com/cars-for-sale`    | `/cars-for-sale/vehicle/791592297` or observed `/inventory/791592297` → `791592297` |

Do not synthesize make/model IDs or query filters. CarGurus may carry a UK postcode into the US site: correct a mismatched location through its dialog and verify the resulting city; reuse an already-correct ZIP. Selecting a make can navigate and collapse **Make & model**: wait for the matching results heading, reopen that filter, then select the model. Match a heading by its observed name using the supported browser locator options.

Autotrader's ZIP field can require sequential typing and blur before **Search Used**; verify the resulting ZIP chip. Wait for dependent model options after selecting the make. In the filters dialog, click the visible label for a hidden delivery checkbox and verify its state. Avoid repeated input timeouts or unchanged submissions.

## Price and facts

Import the full vehicle asking price with `price_kind: asking`, never a monthly instalment, down payment or suggested offer. Cars.com and Autotrader can headline a total including dealer fees: read their price-breakdown table, store the base vehicle price plus separately stated mandatory fees, and quote the total with its exclusions. When only a fee-inclusive price is available, preserve that price and explain the basis without adding those fees again. Sales tax, title and registration may remain excluded; `costs_complete` must remain false when the final cost is unknown.

Read the full dealer/seller description and specifications while the detail is open. Capture location, seller name and observed profile URL, year, make/model/trim, mileage with units, transmission, fuel, drivetrain, VIN/stock when useful, availability and explicit delivery evidence. Keep seller claims and vehicle-history summaries attributed. Model-wide consumer reviews and dealer ratings do not establish the condition of this particular car. Do not use the contact, availability, financing or offer forms to test extraction.

## Gallery capture

Follow [listing evidence](listing-evidence.md) for caching, complete capture and separate visual review.

- **CarGurus:** the `1 of N` button opens a tabpanel with `View vehicle photo N` buttons. Select each ordinal, confirm the full photo's loaded source, and download that element immediately. Its overlay images may be absent from page-assets inventory; capturing each position as it loads avoids a second traversal. A bounded sequential batch can select, check and download several known positions and return a compact manifest.
- **Cars.com:** `See gallery (N)` exposes the full gallery. The page repeats the lead images outside it. The dialog may use slotted elements that a nested role locator does not find; inspect the actual image nodes and map the N gallery slots to their loaded sources. Do not count the duplicate lead strip, dealership photos, price charts or recommendation images. Use the observed assets, never invented CDN variants.
- **Autotrader US:** `N Photos` opens a vertically scrolling gallery. Load it in small scroll steps and inspect loaded sources/natural dimensions; large jumps can leave gaps. Get a full accessibility state when resolving its scroll container, since a diff can omit an unchanged target. Export the matched gallery files through documented page assets; clicking or downloading a photo element can navigate away. Match exact sources first, then an observed variant of the same image path; verify saved dimensions and disclose any reduction. Do not export every image on the page. The Video tab has separate seller players; preserve confirmed duplicate clips at their observed positions. If the player download redirects, use a short timeout (15 seconds), export the video asset on the redirected page and return to the listing. One failed download plus one supported recovery is enough; retain partial capture if recovery fails.

Browser exports can contain AVIF bytes even with a `.jpg` filename. Goodfinds detects the file content. Cache in batches of at most 20 files; verify returned media IDs and listing readback. Downloading does not establish visual review or video playback.

## Completion check

Read back the saved identity, asking price/currency/fees, location, description, specifications and media counts. Keep missing facts unknown. Report explicit access restrictions separately from selector, stale-page or browser-adapter failures. Use one supported recovery, save partial progress and continue. Never report a login, consent or challenge failure as zero search results.
