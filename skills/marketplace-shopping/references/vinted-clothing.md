# Vinted clothing: category and native filters

Read this before browsing clothing on Vinted. Express clothing requirements through the catalogue hierarchy and native filters; use text only for details without a matching control.

## Choose the category

Use the department in the current request or saved brief. Ask once if Women/Men is unresolved, or cover both when the buyer accepts either. XXL alone does not identify a department.

Open the selected browser and use the observed Women/Men menu, Clothing and garment category. For example, the observed men's route is Clothing → Jumpers & sweaters → Hoodies & sweaters. Labels and size systems vary by department; read the breadcrumb and controls instead of inventing category IDs or URLs.

A generic hoodie can also be zip-through. Search applicable siblings when the primary scope has too few matches or the buyer wants comparison/wider coverage. One fully photo-checked suitable pullover can satisfy a request for one hoodie; account for optional skipped queries honestly through [search workflow](search-workflow.md).

## Apply each filter as one transaction

Keep the tab and latest DOM snapshot in the browser runtime. Prefer DOM roles/names for locator ground truth; Category is a button in the DOM even when the accessibility tree calls it a checkbox. Batch the following adaptive steps in one call, observing between actions:

1. Confirm the catalogue is usable. If it shows “Sorry, something went wrong,” recover below before editing another filter.
2. Open the observed filter trigger. Wait for its options or textbox, then select the requested observed value. In Brand, enter the brand in its internal search and select the matching option; typed text alone does not select it.
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

For “No items available with this filter” or a previously available option disappearing while cards remain, close and reopen the filter once after the catalogue settles. Wait for its options. If still empty and the reload is unused, reload once and reopen. Loading, a catalogue error, an empty menu and zero listings are different outcomes.

If bounded recovery fails, record the exact unverified filter and broader scope. A photo-checked candidate can still be useful, but never call that a successful native-filter search. Preserve hard requirements and mark interrupted query coverage partial. Zero results in one scope do not establish no matches across Vinted.

Only mark a query completed after category, selected filter chips, observed URL and refreshed cards agree. A category click alone is not a committed transition. Prefer an observed unique card href or test ID within the catalogue container; exclude duplicate recommendation links. Pass observed names through locator arguments rather than composing CSS selectors from titles containing apostrophes. Read the actual gallery image attributes for media locators.

## Verify the listing

Keep the main text field empty unless a requested detail has no filter. Recheck category and filters after any text submission. Open visible result-card links, then check garment type, department, brand/size labels and pattern on the detail page and photos; suggested cards or seller-entered attributes can be wrong.

Determine availability from the visible listing status and current purchase controls. Vinted's favourites control can contain a visually hidden “Removed!” announcement even on an available listing. That notification does not mean the item was removed; check visibility and its container if it conflicts with an enabled Buy now button. Seller location and delivery eligibility remain separate checks.

Collect description, price, seller details and the observed gallery inventory together. Download media sequentially within the tab in one awaited loop, batch-cache completed files, and inspect every required photo/video through [listing evidence](listing-evidence.md). Use the observed gallery count. Verify the strongest candidate first; additional comparisons depend on the request, not the number of discovery cards. Preserve required media saving, truthful provisional records, query coverage and the buyer's monitoring choice.
