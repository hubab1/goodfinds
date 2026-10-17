# Vinted clothing: categories, filters and recovery

Read this before browsing clothing on Vinted. Prefer the catalogue hierarchy and usable native filters. An empty filter menu can coexist with hundreds of listings; follow the recovery and broader discovery steps below before ending a search.

## Choose the category

Use the department in the current request or saved brief. Ask once if Women/Men is unresolved, or cover both when the buyer accepts either. XXL alone does not identify a department.

Open the selected browser and use the observed Women/Men menu, Clothing and garment category. For example, the observed men's route is Clothing → Jumpers & sweaters → Hoodies & sweaters. Labels and size systems vary by department; read the breadcrumb and controls instead of inventing category IDs or URLs.

Prefer observed category links when available. If clicking changes the heading or chip while the URL and leading cards remain in the old category, read the intended link's actual `href` and load that URL as a full page in the same tab. Confirm the breadcrumb and refreshed cards. A reload of the old URL would lose the pending category. This also works with an observed category-and-brand breadcrumb on a listing; verify the resulting brand chip and cards.

A generic hoodie can also be zip-through. Search applicable siblings when the primary scope has too few matches or the buyer wants comparison/wider coverage. One fully photo-checked suitable pullover can satisfy a request for one hoodie; account for optional skipped queries honestly through [search workflow](search-workflow.md).

## Apply each filter as one transaction

Keep the tab and latest DOM snapshot in the browser runtime. Prefer DOM roles/names for locator ground truth; Category is a button in the DOM even when the accessibility tree calls it a checkbox. Batch the following adaptive steps in one call, observing between actions:

1. Confirm the catalogue is usable. If it shows “Sorry, something went wrong,” recover below before editing another filter.
2. Open the observed filter trigger. A control that only gains focus without opening may have been clicked before the page became interactive; inspect its current state before one retry. Wait for its options or textbox, then select the requested observed value. In Brand, enter the brand in its internal search and select the matching option; typed text alone does not select it.
3. Confirm the checked/selected state. Allow one bounded wait for the updated Show results preview; use its current label/count when available. A preview count is useful, but some transitions retain a bare Show results button. Confirm with the currently observed button rather than repeatedly waiting for a count that never arrives.
4. Wait for the catalogue to settle. Check selected chips, the observed URL and refreshed cards/count against the preview and previous scope. Only then open the next filter or collect listings.

Use condition waits, not fixed sleeps. Return compact selected labels, result count, current URL and any error. Reuse the stored snapshot when an excerpt omitted a control; inspect the active menu or matching option lines rather than printing the entire catalogue or brand list on each turn.

| Requirement       | Native control                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------- |
| Size              | Choose the full displayed label after selecting the category; department size systems differ. |
| Brand             | Search inside Brand and select the matching option.                                           |
| Solid colour      | Pattern → Solid, followed by photo verification.                                              |
| Particular colour | Colour, only when specified.                                                                  |
| Condition         | Only the buyer's accepted conditions; leave unset when unspecified.                           |
| Price/material    | Corresponding controls, only when specified and available.                                    |

## Verify commitment and recover once

A selected chip is optimistic: it can appear while the URL and cards still represent the previous query. In the observed Pattern control, the committed URL contains `patterns_ids[]`. A Solid chip with no Pattern parameter and unchanged cards is an uncommitted selection. Use this as a verification signal; derive navigation from observed controls, not invented filter IDs or URL parameters.

If a selection does not commit, reopen its filter, retain the checked option, read the current preview and confirm Show results once more. A still-visible old count immediately after clicking is a pending transition, not an automatic reason to reload.

For a catalogue error, close the menu, wait briefly for the observed error to clear, then use one reload if it persists. Confirm the committed chips and loaded results afterward; restore any lost requirement through native controls. Reloading may discard pending selections.

For “No items available with this filter” or a previously available option disappearing while cards remain, close and reopen the filter once after the catalogue settles. Wait for its options. If still empty and the filter-recovery reload is unused, reload once and reopen. Loading, a catalogue error, an empty menu and zero listings are different outcomes. A hidden progressbar alone does not establish that options loaded.

If bounded recovery fails, record the exact unavailable control and continue with broader discovery below. Spend this filter-recovery budget once per run, rather than reopening the same empty control for every brand or query. The next scheduled run may probe it again. Complete the independent saved-listing availability pass even when discovery filters fail.

Only report a successful native-filter scope when the category, selected filter chips, observed URL and refreshed cards agree. A category click alone is not a committed transition.

## Continue when native filters are unavailable

Keep the selected browser and saved buying requirements. Use ordinary visible navigation, with no invented filter IDs, private API requests or access-challenge bypasses.

1. Load and inspect the observed garment-category link without narrowing it to a reference brand. Record this broad sample separately from the failed filtered scope. An empty Size menu is not a reason to discard usable category cards.
2. For the planned brand/model scopes, prefer an observed category-and-brand link. Otherwise submit a concise term through the catalogue's visible search textbox, even when that term normally has a native filter. This fallback is retrieval only: a keyword such as XL or black does not enforce size or colour. Avoid stuffing every hard requirement into one query, which can hide useful listings.
3. Read the resulting URL, category, query field and leading card IDs/text. If the URL records the submitted query but cards still contradict it, allow the pending transition to settle, then reload that exact observed URL once. Verify fresh relevant cards or an explicit empty-result state. This is a separate budget for each newly submitted search, not permission to repeat the same failed reload. Overlapping cards or an unchanged capped count such as 500+ alone do not prove staleness. If the submission never reaches a verifiable URL, retain the broader category scope.
4. Continue through a bounded sample of relevant cards. Open their observed links and verify department, garment type, brand, size, colour, condition, full cost and availability on details and photos. Preserve conflicts and unknowns. Import useful provisional evidence and verify the strongest candidates; a failed dropdown does not make those listing checks unavailable.
5. Record only the category, text and filters actually applied in `search_coverage`, with `status: partial` and notes naming the missing filters. Keep pagination and unknown counts truthful. Preserve the original failed filtered query and its reason. Add a distinct fallback query with `add_queries`, initially `planned`, when its broader scope is not already represented; use `purpose: category` for the unfiltered garment-category check. Mark that actual sample completed only after inspecting it. This can unlock shortlist verification without claiming the failed filtered scope succeeded. End the run `partial` while required filter coverage remains failed; use `blocked` when no useful discovery or saved-listing checks can proceed.

Keep a compact recovery note for the next worker: the failed control, actual category/query URL, successful navigation method and unresolved checks. Resume useful coverage instead of replaying every failed menu operation. Zero matches in one sampled scope do not establish no matches across Vinted.

## Verify the listing

For the native-filter route, keep the main text field empty unless a requested detail has no filter. The broader discovery fallback above permits text for unavailable filters. Recheck category and filters after any text submission. Prefer an observed unique card href or test ID within the catalogue container; exclude duplicate recommendation links. Pass observed names through locator arguments rather than composing CSS selectors from titles containing apostrophes. Open visible result-card links, then check garment type, department, brand/size labels and pattern on the detail page and photos; suggested cards or seller-entered attributes can be wrong. Read actual gallery image attributes for media locators.

Determine availability from the visible listing status and current purchase controls. Vinted's favourites control can contain a visually hidden “Removed!” announcement even on an available listing. That notification does not mean the item was removed; check visibility and its container if it conflicts with an enabled Buy now button. Seller location and delivery eligibility remain separate checks.

Save an explicit visible Sold label as `availability: sold` and a Reserved label as `reserved`, retaining its wording in `availability_text`. Photos, prices and descriptions can remain visible on sold items. Every scheduled run must revisit previously saved items through the [availability pass](availability-checks.md); search-result absence is not a sale signal.

Collect description, price, seller details and the observed gallery inventory together. Download media sequentially within the tab in one awaited loop, batch-cache completed files, and inspect every required photo/video through [listing evidence](listing-evidence.md). Use the observed gallery count. Verify the strongest candidate first; additional comparisons depend on the request, not the number of discovery cards. Preserve required media saving, truthful provisional records, query coverage and the buyer's monitoring choice.
