# Goodfinds

Goodfinds is a local MCP plugin for finding, comparing and following up on marketplace listings. Describe what you want to buy, refine the important requirements, and keep your searches, listing evidence and seller conversations together in an interactive panel.

## What it does

- Turns buying briefs into editable searches, with research, must-haves and preferences.
- Compares suitable listings using their specifications, condition, asking prices and saved evidence.
- Keeps photos, price history, shortlists and feedback so you can pick up where you left off.
- Supports one-off searches and recurring checks through your host's browser, background agents and scheduling tools.
- Prepares seller messages and collection arrangements for your review. Sending requires approval of the exact message; a saved draft never contacts a seller.

Goodfinds recognizes Facebook Marketplace, eBay, Vinted, Gumtree, UK Auto Trader and Craigslist. Available collection and contact routes differ by marketplace. Facebook uses host browser controls; eBay's Browse API requires application credentials. Other marketplaces support navigation and evidence import. Read [marketplace validation](docs/marketplace-validation.md) for current integration coverage and limitations.

## Run locally

Development requires Bun 1.4.2 or later on macOS or Linux.

```sh
bun install
bun run build
bun start
```

Open the device-local URL printed by the server to use the panel. New live workspaces start empty; demo mode supplies fictional searches and listings. Use `bun run dev` for panel development.

To build an installable plugin:

```sh
bun run package
bun scripts/smoke-plugin.ts dist/goodfinds-marketplace
```

The package contains a standalone executable, the panel and the [marketplace-shopping skill](skills/marketplace-shopping/SKILL.md). Installed plugins need no Bun or Node installation. Load `dist/goodfinds-marketplace` through your MCP host's local plugin support; `plugin.json` and `mcp.json` define the plugin and server. Browser actions require compatible host tools. Recurring checks require a host schedule, an awake device and a running host app.

Each package targets one operating system and CPU, recorded in its ZIP filename. Packaging defaults to the build machine. For example, `GOODFINDS_BUILD_TARGET=bun-linux-x64 bun run package` builds for Linux x64. Supported targets are macOS and Linux on ARM64/x64, including Linux musl variants. Validate each package on its target platform before distribution.

## Your data

Searches, evidence and conversations stay in the local workspace at `~/.local/share/goodfinds`. Set `GOODFINDS_WORKSPACE_DIR` to use another location. Demo initialization uses fictional data and never reads the live database. Marketplace credentials and browser sessions remain separate from saved searches.

```sh
./dist/goodfinds-marketplace/server/goodfinds backup --db /absolute/path/workspace.sqlite --output /absolute/path/new-backup
./dist/goodfinds-marketplace/server/goodfinds restore --input /absolute/path/new-backup --output /absolute/path/new-workspace
```

Backups include committed databases, cached media and connection checks, with integrity verification. Restore creates a new directory. Host schedules and credentials remain with the host. Development output, builds, local databases and secrets are excluded from Git.

## Development

The panel and server share validated contracts in `packages/contracts`. Start with [server architecture](docs/server-architecture.md), [interface design](docs/ui-design.md) and [domain vocabulary](CONTEXT.md). The [roadmap](docs/roadmap.md) tracks open work.

```sh
bun run docs:generate # after changing shared state definitions
bun run check
bun test ./tests/*.ts
```

Validation includes a focused seller-send specification using a pinned Lean toolchain. Install [elan](https://lean-lang.org/install/) and follow the [formal model guide](formal/README.md). The model checks permission and reconciliation guarantees; live browser integrations require separate validation.
