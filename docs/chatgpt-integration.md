# ChatGPT integration

Goodfinds implements the [OpenAI MCP Extensions specification](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md) through its existing Rust MCP server and MCP Apps panel. It does not require the OpenAI extension SDK.

## Entrypoints

The sidebar opens **Goodfinds** through `open_goodfinds_home`. A chat can open **Searches and listings** through `open_goodfinds_panel`. Each tool advertises one entrypoint and accepts empty arguments. Both use the same panel resource and saved workspace. The existing panel tool also accepts `search_id` and `listing_key`; ordinary workspace reads do not change the current view.

## Selected listing context

While a listing's detail dialog is open, the panel provides its identity, selected search when known, title, source URL, observed asking price, currency, price period and observation time as structured model context. Chat can use `get_goodfinds_listing` to fetch current evidence. Opening a dialog does not attach private seller conversations or photo/video bytes, send a message, or authorize a buying action.

Closing the dialog, navigating away or changing workspace clears the selected listing. Host updates are serialized so a delayed update cannot leave an older selection active. Hosts without `updateModelContext.structuredContent` keep the normal panel behavior.

## Composer mentions

The server advertises `extensions["openai/mentions"].searchTool = "search_goodfinds_mentions"`. This read-only, app-visible tool accepts `query` (up to 200 characters, including an empty string) and optional `mode`. The default is the live workspace; sample data requires `mode: "sample"`.

Each response contains at most ten saved searches and ten listings. Search names, IDs and product categories are matched case-insensitively; listings match titles, keys and locations. Listing results prefer the most recently observed records. Lookup does not evaluate listings, mark them read or activate searches.

Results are MCP resource links under `goodfinds://live/searches/…` or `goodfinds://live/listings/…` (and the equivalent `sample` namespace). `resources/read` resolves the exact current saved search or listing. Deleted or unknown resources fail explicitly; reading a sample reference never falls back to live data. Resource links do not have to appear in `resources/list`.

Composer mentions require host support. The upstream platform table currently lists them for desktop.

## Deep links

The panel accepts `hostContext["openai/deepLink"].url` during initialization and subsequent host context changes. Paths are app-relative:

| Path                              | Destination                   |
| --------------------------------- | ----------------------------- |
| `/` or `/searches`                | Saved searches                |
| `/searches/<encoded-search-id>`   | Listings for one saved search |
| `/listings`                       | All saved listings            |
| `/listings/<encoded-listing-key>` | One listing's detail dialog   |

Paths default to live data. Add `?mode=sample` for fictional sample data. Listing paths can include `search_id=<encoded-search-id>` to retain the comparison scope. Encode each ID as a single URI component. Unsupported paths, absolute URLs, fragments and action parameters are ignored; links only navigate. Missing saved items show an unavailable message.

Use the shared `panelPath` and `panelDeepLink` functions in `packages/contracts/src/panel-presentation.ts` to construct links. Supply the actual installation identity; custom marketplace names and published plugin IDs are not interchangeable. For this repository's `local-goodfinds` development marketplace:

```text
codex://plugins/goodfinds-marketplace@local-goodfinds/app/open_goodfinds_home?path=%2Fsearches%2Fmy-search
```

For a published plugin, omit `@marketplace` and use its registered plugin ID. The app-relative path is encoded again as the outer link's `path` query value. The incoming link is applied after the workspace loads and takes precedence over the initial opening tool result. Later theme or context updates do not repeat navigation.

## Verification

`tests/mcp-extensions.test.ts` exercises capability discovery, entrypoint calls, mention lookup, resource reads, workspace isolation, path validation and ordered context updates. `tests/panel-handoff-ui.test.ts` covers actual panel navigation, detail dialogs, context cleanup, missing items, unsupported context hosts and initial-link races using an isolated simulated host. These checks do not establish live-host support for every ChatGPT release.
