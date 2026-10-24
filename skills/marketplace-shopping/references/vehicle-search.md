# Vehicle searches

Use this guide for vehicle setup, discovery, verification and price comparisons, alongside the shared search workflow. Marketplace controls change; derive locators from the current browser documentation and rendered page.

## Brief and identity

If this chat’s mounted setup tool lacks the `vehicle` starter while the installed helper exposes it, follow [connection diagnostics](connection-diagnostics.md) and use that current helper for affected setup, imports and evaluation until the host refreshes its connection. Existing chats can retain an older engine after a local update.

Start with the `vehicle` setup template, adapting its typed fields to the buyer's supplied requirements. Keep make and model separate: Nissan / Juke, not model `Nissan Juke`. Store year bounds, transmission, full cash-price ceiling, driving time, functioning and history requirements as matching answers. An exact model uses `discovery.scope: exact` with that same model identity. CVT and Xtronic describe a gearbox; record `transmission: automatic` only when the visible vehicle specification supports it. Semi-automatic wording needs the actual gearbox checked against the brief.

Save make and model from explicit card/detail evidence on every vehicle observation, including alternatives. Missing identity stays unknown and is not a confirmed exact-model match. Read the saved assessment after import; a shared vehicle pool can contain cars found by another search. Discovery counts and worker queues retain their own search/run identities.

## Filter readback

Use native filters before narrowing keywords. Enter the buyer's origin through the site's location control; if a postcode is required, obtain a publicly evidenced central postcode for that town and label it as an approximation. A retained neighbouring-city postcode is partial discovery, not the requested location. Choose a supported radius broad enough to discover the intended driving region; a short default radius cannot establish coverage of a 90-minute drive. Verify individual journeys from the saved origin.

Apply parent controls before dependent controls: marketplace category, vehicle type, make/model, then year and price; set transmission after any vehicle-type change. Reopen controls when needed to verify the persisted state. Following the final change, read back **all** required controls and the current result heading/count plus leading listing IDs. A URL parameter or typed value alone is not proof. If a change resets another requirement, restore that requirement and read the whole state again. Keep a compact coverage record of actual category, location/radius, make/model, years, gearbox, price and sort, with any unapplied values explicit.

A whole-pound maximum of £2,000 includes an exact £2,000 advert. For a strict under-£2,000 brief, use the nearest broader supported filter and enforce £1,999.99 on each full cash price; a £1,999-only filter omits possible prices between those amounts. Keep deposit, monthly finance, auction starting prices and full cash prices separate.

### AutoTrader UK

Use Cars, verified collection origin and native make/model, registration-year and Automatic filters. A single parameterized search may bootstrap the requested scope; confirm every selected control on the resulting page. Check ordinary cards separately from promoted cars and suggested alternatives. Prefer a useful native sort such as lowest full price or nearest, then inspect enough matching cards to replace rejected leads.

Consent may be in an iframe. Use the observed frame/control with supported semantic actions, a fresh DOM read and one retarget; one supported visual alternative is sufficient. A failure budget covers that control across the run, including detail/gallery pages. When the same interaction failure persists, preserve readable evidence, mark affected controls/gallery incomplete and move to another source. Repeating hidden/visible tab creation or the same consent clicks does not expand coverage.

### Gumtree

Select Cars before make/model, year, gearbox and price. The previously observed `min_year` URL parameter did not apply a year filter; use the native Year control and confirm its selected chip and resulting count. The observed native year parameter is `min_vehicle_registration_year`. When the exact lower year is absent, choose a broader supported year and enforce the saved bound on individual cars. Verify category/radius again after a new keyword search. Automatic, Semi-Auto and Other are separate transmission buckets; a broad automatic search can inspect all three and confirm actual gearboxes on detail pages. Count ordinary local results separately from extended-area recommendations, scooters, wheels and finance adverts.

Read the Vehicle history section as paired check **and outcome**. `Not Cat S/N: Advisory` is an adverse/uncleared category check, not proof of a clean vehicle; preserve the complete disclosure. It does not identify S versus N. `Not imported: Advisory` concerns import status, not proof of accident damage. A seller's HPI-clear claim and the platform's own findings remain separate evidence, including contradictions.

### Facebook Marketplace

Enter Vehicles, then the appropriate car/vehicle type before setting make, model, year, full price, and Automatic. Use the native make/model controls for an exact model: submitting new text in Search Marketplace can leave Vehicles and discard its filters. Changing the vehicle type can reset transmission to All. Set Automatic last and verify its checked state along with the other controls on the final page. A custom radio's immediate `check()` error may precede a successful page update; read its settled checked state before retrying. If restoration fails, record partial keyword discovery; neither the query word `automatic` nor an unchecked radio establishes applied filtering. Confirm the displayed town and radius, and keep suggestions/wider results separate.

Commit each range change with Enter and read the settled page before editing another dependent field. Input text alone can precede a discarded navigation update. When moving between briefs, clear the selected model before its make, or start from the visible Vehicles category again: clearing make alone can hide an old model restriction. Compare the visible controls with applied URL parameters and refreshed result IDs. A residual model/year or a missing applied range is a conflict to recover, not a valid empty search. A URL-only edit that returns general-search controls has lost vehicle filtering even if old parameters remain in its address.

Inspect title, vehicle fields, description and odometer together. Preserve conflicting kilometres/miles, years, prices, gearbox descriptions, warning-light claims and recycled gallery photos. A warning symbol needs its visible identity and ignition/running context recorded; a photo alone does not diagnose a mechanical fault.

When strict native filters return no or very few whole-car leads despite broader keyword results, keep one broader keyword pass and verify the missing attributes in each detail page. Record it as broader discovery; do not call it successfully filtered inventory. A recent UK registration or import date does not establish a recent manufacture/model year. Conflicting year text remains unresolved or excluded under the buyer's age limit.

Before accepting an empty native vehicle search, inspect the search text as well as the filter controls. A literal `Vehicles` category label can remain a keyword and suppress matching cars. Try clearing that text through the visible search control once, then read back the category, required filters and results. If this loses vehicle filters, use the broader pass above and record that limitation.

## Eligibility before galleries

Read full cash price, exact identity, year, transmission, location, condition/fault wording and category/history disclosures before deep gallery work. Reject explicit non-runners, gearbox faults, spares/repair and disallowed categories. Do not make a rejected car the recommendation merely because it is cheapest. Keep decisive exclusions and useful counts in coverage; save an excluded listing only when its evidence/history is useful. Existing excluded listings still receive scheduled availability checks.

For a remaining candidate, save explicit `make`, `model`, `year`, `transmission`, `mileage` and `mileage_unit` (`miles` or `km`), plus observed fuel, engine, body and trim. An ambiguous unit stays unknown. Confirm each must-have with its source and record contradictions in `field_evidence` or `verification_checks`, not just prose. Distinguish seller claims, platform checks and independently inspected records. HPI clear does not by itself establish no unrecorded accident damage. An MOT claim needs its date/source; an MOT does not establish gearbox or engine condition. Paid history reports and seller contact retain their separate buyer authorization.

A selector boot or unreadable PRND markings alone leave the gearbox unknown; identify an actual manual shift pattern or clutch before recording a contradiction to an automatic claim. Retain both advertised and photographed odometer readings with their sources. A small increase or rounded advert value is not by itself contradictory; reserve conflicting mileage evidence for incompatible units, material unexplained differences or another explicit disagreement. These observations do not establish mechanical health.

Review and capture the entire available gallery for candidates being verified. Stop further gallery/journey work after a decisive exclusion. Keep discovery thumbnails separate from numbered gallery positions; seven gallery files plus a thumbnail are not eight reviewed positions. Import a current detail check as `collection_stage: verification` with the actual partial/complete review. Media-only repair uses its separate tool and preserves old fact timestamps. Supply every photo’s `media_id`, `position` and `caption`, and respect the cache tool’s advertised batch limit. Omit unknown optional counts rather than sending schema-invalid nulls; retain the current import schema for subsequent batches.

## Good results and deals

Compare full cash prices for the same make/model, year, gearbox, fuel, engine, body and trim with compatible condition. Vehicle price cohorts convert an explicitly stated distance unit to miles and use 25,000-mile bands instead of requiring identical odometer readings. Unknown units cannot establish comparable mileage. Bands are coarse context; inspect large mileage differences and differences near a boundary before recommending a bargain.

Gather several equivalent, current asking-price peers, including above-budget cars when needed for comparison, while keeping their budget failures visible. Record the actual sample and deduplicate cross-listed stock using observed registration/stock identity. A low price among unrelated, damaged or finance-only adverts is not a deal. Keep comparative asking-price value separate from suitability and verification; few peers or unresolved history mean no verified bargain claim. A detail-verification-stage import or `verified_keys` entry does not mean all buyer requirements passed.

Replace failed shortlist candidates with the next eligible cards from the same verified scope before ending a search for useful options. Report confirmed matches, conditional leads, exclusions and source/coverage gaps separately. Preserve a strict brief when no suitable car is found. Prepare a short plain-language enquiry using the seller-message guide: prioritize required accident/category history, an uncertain required gearbox, then functioning, before minor descriptive discrepancies. Ask about the concrete fact rather than internal observation conflicts. Keep it unsent until reviewed by the buyer.
