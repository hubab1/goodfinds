# Search card images

Choose a cover that makes the search recognizable at a glance. Use the user's requested image style when supplied; otherwise keep white backgrounds and monochrome presentation. The panel applies grayscale to search covers and preserves the original image bytes. Listing photos retain their original colors for evidence review.

For identifiable products this is a required automatic follow-up after initial discovery, including searches with no listings. Resolve cover_follow_up from save results and cover_follow_ups from search context before finishing. Reuse a suitable photo already saved in the user's workspace, or find an official photo, download the observed asset, cache it locally and attach it. The installed plugin contains generic illustrations; product photos belong to the user's workspace. Make one bounded attempt (up to 60 seconds) per follow-up; if blocked or no suitable image is available, report the specific reason, retain the category fallback and retry on a later search. The fallback alone does not complete this step. Keep intermediate image fetching quiet.

## Choose the image

- **Identifiable products:** Fetch a clear product photo from the manufacturer's official product page or image library. For MacBook Pro, Mac mini and Mac Pro, use Apple's product pages. Match the requested model or generation; when only a verified family photo is available, label that family clearly as representative. Prefer the product alone over a lifestyle scene, accessories, or a screenshot of a webpage. Record the reference product in discovery.reference_model so missing-photo follow-up is visible in tool results.
- **Property to rent:** Choose a house, apartment or room illustration using the search's location and property type. Read the localization guidance below. Keep the saved area as text in the card, label the artwork as an AI illustration and retain its prompt.
- **Area-focused property searches:** If the user prefers local context, use a real neighborhood or landmark photo verified to be from the searched area, with its source page. Label it as an area reference. A generic stock property photo is a secondary option, visibly labeled representative. Neither image establishes that the depicted home is available or meets the rental brief. Keep actual property listing photos on their own listing cards.
- **Generic vehicles:** Use a bundled sedan, 4×4/SUV, motorbike or boat illustration when the brief identifies that type but no particular model. A named vehicle model follows the product-photo route. Match the saved body or vehicle type; leave an unspecified or mixed type on the category icon until a useful choice is known.
- **Broad or unbranded marketplace items:** Reuse a matching furniture, bicycle, garden-furniture or pram illustration. Dimensions, materials, style and practical needs can make the brief detailed without identifying a manufacturer/model. For example, a narrow vintage chest of drawers still fits category artwork when its maker is unknown. Keep `discovery.reference_model` for a real named product, not a description of requirements. For a named model whose photo cannot be found, report the bounded attempt's blocker and retain a suitable illustration; the illustration does not complete its photo follow-up.
- **Services or categories without a particular product:** Use a simple category illustration. Generation may help when a distinctive illustration adds recognition; otherwise the category icon is a usable fallback. Use user-provided images when requested. For third-party stock imagery, use a source with suitable reuse permission and retain its attribution.

Reuse a suitable existing cover instead of generating or downloading a new image every time the search runs. Reconsider it when the category, requested model, rental area, property type or user image preference changes. Preserve it through routine budget and other search edits when its subject still fits. Image selection must not delay saving the user's requirements: retain the category fallback if browsing, downloading or generation is unavailable.

## Reuse generic covers

Call `list_goodfinds_search_covers`, optionally filtered by `category: furniture`, `cycling`, `garden`, `baby`, `vehicle` or `rental`. Furniture includes sofa, dining set, wardrobe, chest of drawers and sideboard; the other new presets are bicycle, garden furniture and pram. Pass the selected `cover` object directly to `set_goodfinds_search_cover`; it is already available locally and needs no download or cache step. Match the item type in the brief. A broad furniture, garden or baby-equipment search keeps the icon until the subject is known; choose a custom illustration for a mixed brief when useful.

The panel selects known item-category defaults and vehicle defaults from an explicit category, `body_type` or `vehicle_type`, including a single selected type. A broad car search or several selected body types keeps the category icon instead of guessing a sedan. Catalog illustrations remain fictional category references even when their shape or included objects differ from the requested specification.

For other generic categories, reuse a fitting illustration or create one only when it adds useful recognition. Match the rental covers: refined miniature model, crisp simplified geometry, matte white and neutral grays, three-quarter/isometric view, soft contact shadows, centered subject and generous white space. Keep the complete subject visible. Retain the prompt and label it as a fictional AI illustration; it does not depict an available item or establish its specifications. User-requested images take precedence.

## Localize rental illustrations

Use the place being searched, including country or region supplied in the brief. The viewer's device locale, language and currency do not establish that location. Resolve an ambiguous city from existing conversation context or verified geography; otherwise keep the neutral illustration while saving the search. For example, "London, Ontario, Canada" uses Canadian imagery, while an unresolved "London" remains neutral.

Call `list_goodfinds_search_covers` with `category: rental` to read the available neutral, UK, US, Canadian, Australian, French and German illustrations. The panel automatically chooses a regional default when the saved `country` answer or the comma-separated area suffix explicitly names one of those countries; other locations use neutral. To select a preset for a country established elsewhere in the brief, pass its returned `cover` object to `set_goodfinds_search_cover` and add `location` containing the exact saved rental `area`. Bundled images already exist locally and need no download or cache step.

These presets are broad fictional styles. Choose a custom illustration when the city, region or requested property type needs a different look, and for countries without an appropriate preset. An urban apartment search can use an apartment building, a house search a house, and a room search a simple interior. Treat European countries and regions individually. Use everyday housing details supported by the locality; when unfamiliar, inspect suitable local architectural references or choose restrained contemporary forms. Keep the same white background, monochrome palette and architectural illustration style. Prefer housing over flags, landmarks or tourism imagery.

For generation, include the searched place, property type and a few suitable architectural details in the prompt, plus the shared card style and its fictional role. Example: "Monochrome architectural-model illustration for an apartment rental search around Valencia, Spain; a modest contemporary apartment block with balconies, centered on white, soft gray shadows, readable at card size. Fictional search illustration, no address, availability claim or text." Retain that prompt, cache the output, and attach it with `location` set to the saved area.

A cover tagged with `location` resets to the appropriate default when that area changes. Re-evaluate the architecture when editing a rental area or property type. User-requested images take precedence over presets.

## Save a custom cover

Download the actual chosen image through the host's supported browser or page-asset tools, using an observed image URL rather than guessing one. For generated artwork, use the host's image-generation tool and its returned local file. Cache the JPEG, PNG or WebP file with `cache_goodfinds_images`; keep the original outside the installed plugin's writable state. The cover is served from local media, so opening the panel does not contact Apple, a stock provider or a property website.

Read `get_goodfinds_workspace` for the current revision, then call `set_goodfinds_search_cover` with the saved `search_id`, `expected_entity_revision` from `revisions.searches[search_id]`, workspace `mode`, and a `cover` object:

```json
{
  "media_id": "<ID returned by cache_goodfinds_images>",
  "kind": "manufacturer",
  "alt": "Representative photo of a MacBook Pro laptop",
  "source_name": "Apple",
  "source_url": "https://www.apple.com/uk/macbook-pro/"
}
```

Supported kinds are `manufacturer`, `generated`, `area`, `stock` and `user`. Manufacturer, area and stock images require their HTTP/HTTPS source page. Generated images require `prompt` and a source name such as `AI illustration`; their description must identify them as illustrations. Use `alt` to describe the subject. For localized rental illustrations and area references, also include `location` with the exact saved rental area so an area edit clears a stale cover. The panel labels the source and image role. Pass `cover: null` to restore the location-aware category default.

Completion means the returned saved search contains the intended image metadata and the panel displays the selected local image. A failed fetch requires the concrete blocker to be reported with the results; do not describe the fallback as a fetched cover. Keep representative covers separate from listing `photos`, seller avatars, image-review records and matching evidence. Changing a cover does not change comparison rules or generate another deal alert.

## Why these categories

Prefer a small library for common item types whose briefs can describe dimensions, use or style without identifying a model. The initial priorities are sofas, dining sets, wardrobes, chests of drawers, sideboards, bicycles, garden furniture and prams. This selection is an inference about useful search recognition, supported by marketplace demand signals checked on 7 October 2026:

- Gumtree reported January 2026 searches of 750,000 for sofas; 200,000 each for bikes, chests of drawers and wardrobes; 190,000 for dining tables and chairs; and 160,000 for sideboards. These are searches, not completed purchases or counts of broad briefs. [Gumtree, 12 February 2026](https://www.gumtree.com/info/life/p/life-advice/whats-hot/sell-on-gumtree-2026-trends/).
- Gumtree's spring report included garden furniture and lawn mowers among its most-searched items, without comparable search counts. Garden furniture therefore adds a useful outdoor category without implying a popularity rank. [Gumtree, 16 April 2026](https://www.gumtree.com/info/life/p/life-advice/trends/sell-on-gumtree-best-time/).
- Gumtree's baby-item analysis included prams, cots and changing tables as common purchases. A pram provides a recognizable cover for a broad pushchair brief; a named model still warrants a fetched product photo. [Gumtree, 14 September 2026](https://www.gumtree.com/info/life/p/gumtree/press/save-on-baby-items-second-hand/).
- Vinted reported strong women's and children's clothing performance in 2025. Defer a single fashion cover: it cannot usefully distinguish unrelated garment types. Add a specific garment or bundle illustration only when recurring briefs justify it. [Vinted, 9 April 2026](https://company.vinted.com/newsroom/financial-results-2025).

Unbranded, vintage and custom furniture also fits generic artwork when no reliable model photo exists. The sources do not measure that difficulty or the frequency of broad searches. Do not treat an illustration as evidence of a listing's design, materials, condition or included parts.
