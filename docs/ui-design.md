# Goodfinds interface design

Keep the interface monochrome: white surfaces, black text and black action buttons with white labels. Use spacing, labels and placement to explain actions. Action variants share one visual treatment; inline links remain text links.

## Front-end organization

`apps/ui/src/App.tsx` composes the application shell and navigation. `app/use-workspace.ts` owns workspace state, subscriptions, polling and the shared mutation guard. Feature code lives in `features/searches`, `features/listings`, `features/conversations` and `features/settings`; keep a feature's views, controllers and CSS together.

Shared controls live in `components/ui`. They receive display values, interaction state and callbacks through props. They may own UI behavior such as focus, keyboard navigation and disclosure state, but never import feature code, domain contracts or transport. `bun run architecture:check` enforces this dependency rule.

Feature controllers own workflow orchestration. `use-search-editor.ts` handles search validation, review and saving; `search-actions.ts` queues and dispatches searches with injected dependencies. `use-seller-conversation.ts` exposes named actions for drafts, reviewed sends, replies and collection plans. Conversation views render those values and call those actions. Business definitions and server authorization remain in the shared contracts and backend.

`lib/actions.ts` derives command inputs from `OperationInput` and the shared tool-name map. Commands require typed payloads. `lib/client.ts` translates snapshot revisions and owns transport; do not reimplement either concern inside shared controls.

## Shared UI composition

- Use `FormField` for a label, optional help text and validation error. `Input`, `NativeSelect`, `Select`, `Textarea`, `Checkbox` and `Switch` inherit its control ID and accessibility associations. Use `group` for related controls; it renders a fieldset and legend. Keep validation rules in the feature.
- Use `Menu`, `MenuTrigger`, `MenuContent` and `MenuItem` for action menus. Base UI owns positioning, keyboard selection, nested Escape and focus return. `HostMenuAction` adapts a host request to this menu interface and retains request feedback.
- Use the existing size props on shared controls for supported variations. Keep colors, focus treatment, field sizing and touch behavior in shared controls and their CSS. Feature CSS owns layouts and feature-specific content.
- Keep global `styles.css` limited to tokens and base rules. Shared overlay and control CSS live alongside their implementations. Search rows, listing cards, media and other feature layouts load their own styles.
- Reuse existing feature compositions before adding generic abstractions. A domain view may accept domain data; a shared control must not require a workspace snapshot or a tool name.

## Dialogs and sheets

`DialogContent` and `ResponsiveOverlay` share the rules in `apps/ui/src/components/ui/responsive-overlay.css`. Use `DialogHeader`, `DialogBody` and `DialogFooter` for desktop dialogs. `ResponsiveOverlay` becomes a bottom sheet below a 640 px panel viewport, including narrow desktop panels. The caller owns the draft so resizing preserves it. Sheets account for the keyboard and safe-area insets.

| Element       | Rule                                                                    |
| ------------- | ----------------------------------------------------------------------- |
| Surface       | White, thin neutral border, 16 px corner radius                         |
| Width         | 560 px by default; listing details use 896 px                           |
| Spacing       | 24 px desktop, 20 px mobile                                             |
| Title         | Left aligned, 20 px, short and descriptive                              |
| Description   | Optional; explain the immediate choice in one sentence                  |
| Scrolling     | Body scrolls; header, close control and footer remain visible           |
| Close control | Black button with a white X and an accessible label                     |
| Actions       | Black buttons, ordered cancel/back before submit; explicit action verbs |
| Touch         | At least 44 px action targets inside overlays; allow wrapped labels     |
| Motion        | Short transitions; disabled for reduced-motion preferences              |

## Interaction rules

- Escape closes the current overlay. An open menu or other nested popup consumes Escape before its parent dialog.
- Focus stays inside an open modal and returns to its trigger when it closes. Desktop editing opens on the first available field. Read-only panels focus their container. Touch opening avoids automatically summoning the keyboard.
- Use native forms with an explicit submit button. Footer buttons outside the form must refer to it using `form`. Other action buttons use `type="button"` (the shared Button default).
- Enter in a single-line field follows native form submission and validation. Enter in a textarea adds a line. Do not install a global Enter or Escape handler: it would interfere with composition, dropdowns and nested overlays.
- Search edits proceed through review before saving. The new-search description submits its own questions flow.
- Enter in seller message fields saves a draft. Sending a message requires the explicit send action. Collection plans submit to Save plan; preparation and purchase recording stay separate actions.
- Disable repeat submission while saving and guard against two submissions before React rerenders. Closing a dialog does not cancel an action already accepted by the server; its completion must not close a newly opened dialog.
- Keep errors close to the form, announce them and retain the user's entries. Native required, range and format constraints remain enabled in the live interface.

Icon-only actions need accessible names; decorative icons use `aria-hidden="true"`. Essential explanations must be available by click or inline, including on touch devices. Tooltips are supplementary.

## Search recency and seen listings

Saved search rows show the last actual search start, the latest first discovery and a count of new listings. Queuing a run does not count as searching. Rechecking an existing listing does not move its first discovery. Older workspaces use recorded run evidence where available and show “Last searched: Not yet” when there is none.

A card counts as seen after one continuous second of substantial viewport visibility. Hidden tabs, inactive panels and cards behind a modal do not count. Viewing one search saves receipts only for that search; the combined listing view saves receipts for its associated searches. Agent reads never mark buyer listings as seen. Receipts persist in SQLite, separately from search criteria and editing revisions. Unknown historical reading activity is not inferred.

The new count opens listings the buyer has not viewed yet. Cards remain in place as their receipts save, so scrolling never removes the card under the user. Changing the filter or revisiting the search refreshes the unseen view. Receipt writes batch in the background and do not dispatch chat messages or disable other controls. Failed writes retry while the card remains visible.

| Time display                                                            | Treatment                                          |
| ----------------------------------------------------------------------- | -------------------------------------------------- |
| Last search, latest find, listing found/checked                         | Time ago; exact local date, year and time on hover |
| Activity, seller/profile checks, conversation messages                  | Time ago with the same exact-date hover            |
| Next scheduled check                                                    | Relative future time with exact-date hover         |
| Price chart points, historical price rows, uncertain publication ranges | Explicit dates, including the year                 |
| Seller join year, warranty and collection appointments                  | Keep their existing explicit calendar meaning      |

Relative labels share one clock and refresh every 30 seconds and when the app becomes visible.

## Compact lists and shared controls

Use fixed slots for a search's cover, identity/criteria, monitoring, result counts/recency and budget/actions. Wide panels align those slots across rows; narrow panels stack them. Keep both Last searched and Last found visible. Counts open the relevant listings; new listings are independent of monitoring. Completion needs no “Updated” badge. Only active work has a spinner; incomplete attempts offer Retry search and a reason available by click. A run failure never changes monitoring or the buyer's pause choice. Monitoring labels reflect both buyer preferences and observed host schedules; setup or unverified states cannot appear active.

Use the shared shadcn/Base UI `Select` for listing filters and the shared shadcn `NativeSelect` for simple form fields. Every dropdown reserves space for its chevron with a consistent edge inset; a local field rule must not override that padding. Custom selects support keyboard navigation, selection, layered Escape and focus return through Base UI.

Use `Disclosure` for preferences, settings and listing detail sections: the same 48 px minimum header, typography, padding, right-aligned chevron and focus ring. Settings sections can expand independently. Keep menus and listing links outside disclosure triggers; a row with several actions must not become one button. Keep Market history and marketplace launch links out of the Listings page; their data and agent tools remain available.

Recovery runs in the host's buying workflow. Existing schedules retry at permitted times; a worker may retry a transient read once. The panel does not itself create agents, activate schedules or claim an automatic retry is underway before a worker has actually claimed it.

## Listing details

Keep the listing title, marketplace logo and location together in the header. The scrollable body starts with a full-width gallery and a summary: side by side from 768 px, stacked below that. Price leads the summary; specifications share a label/value grid, followed by the compact seller profile. Keep Open listing and the message action together in the persistent footer.

Description and search comparisons use consistent section headings and 16 px inset borders. Additional costs, listing history, price history and saved evidence use the shared disclosure. Use `DetailFacts` for specifications, comparison dimensions, costs and history so labels, values and dividers align. Category-specific values use their declared labels and units; missing specifications remain explicit. Estimates and unknown total costs remain distinct from observed amounts. Gallery controls stay together below the media and announce the selected item.

Listing photos preserve the complete sharp foreground with `object-fit: contain`. Decorative blurred bands sample the corresponding outer edges without obscuring or cropping evidence. [photo-background.ts](../apps/ui/src/lib/photo-background.ts) calculates bands from the decoded image and container dimensions; media views update them after loading and resizing.

## Seller conversations

Listing cards and details open the same responsive composer. Show listing, seller, platform and asking price together. One canonical listing shares a conversation across searches; equivalent items on different platforms retain separate threads. Current lifecycle actions come from shared workflow projections and the [state reference](../skills/marketplace-shopping/references/state-model.md#seller-actions).

Preserve saved drafts and buyer edits. Price defaults use the selected or unambiguous associated search, with compatible currency and price period; ambiguous offers need a search choice. An asking price already within budget calls for an enquiry without a price proposal. Percentage shortcuts are explicit arithmetic conveniences. Collection defaults to unspecified and never invents availability. Changed structured terms require reconciling edited wording, never silently replacing it. Follow [seller conversations](../skills/marketplace-shopping/references/seller-conversations.md) for wording and execution procedures.

Show the exact outgoing text before an explicit send action. Saving, copying and host handoff do not establish sending. Manual routes provide copy/open and user-reported history. Native offers and their companion messages have separate eligibility, review and outcomes; live support is limited as described in [marketplace validation](marketplace-validation.md).

After outreach, show messages, timestamps, offer/collection terms and action history. Keep Last checked distinct from Last reply. A suggestion or Accept action prepares a reply for review, never silently sends or records a purchase. Multiple reply intents remain visible. Send uncertainty takes priority over older status; waiting does not imply rejection, and Delivered/Seen labels require platform evidence. Explicit reply checks do not imply background inbox monitoring.

Keep agreed and advertised prices separate. Collection plans retain date, time zone, location, requested checks and confirmation evidence; changed terms clear old confirmation. Only an explicit buyer-confirmed purchase fulfils linked goals. Keep message corrections and user-reported provenance visible in history.

## User-facing terminology

Use “New” for listings the buyer has not viewed yet. This refers to reading activity, not a claim about when the seller published the listing. Clear the badge and count after the existing visibility check; show no “All seen” or “0 new” label beside the search’s listing count. Keep technical names such as `unseen_count` and `seen_in_searches` inside the data model.

Use short, specific nouns and action verbs. Prefer “Search details” over “Full requirements,” “Budget” over “Threshold,” “Available” over “Active” for listings, and “First found” over “First seen” for discovery dates. Reserve “Active” for automatic searches. Use “Not stated” for absent seller details, “Not checked yet” when no check has happened and “Not confirmed” when evidence is insufficient. Do not turn a missing value into a negative finding.

Keep factual distinctions visible: a queued message is not a confirmed send, a manually added reply is not an independently checked reply, and an incomplete search does not mean monitoring is paused. Keep the name “Disregard” consistent across that action, its reasons and confirmation.

Keep implementation terms out of buyer-facing controls. Use human-readable outcomes and reasons from the workflow, preserving the buyer's wording and saved evidence. Outstanding status-text work is tracked in the [roadmap](roadmap.md).

## Validation

Use the isolated DOM fixtures in `tests/helpers/dialog-ux.ts` and `tests/helpers/listing-reading-ui.ts` for keyboard, form, focus and reading behavior; `tests/panel-workflows.test.ts` checks command and recovery paths. Review actual dialogs, sheets and layouts in a browser after visual changes. Simulated DOM tests do not establish visual or live-host behavior.
