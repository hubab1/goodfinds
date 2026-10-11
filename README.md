# Goodfinds

Goodfinds is a local MCP plugin for finding, comparing and following up on marketplace listings. Describe what you want to buy, refine the important requirements, and keep your searches, listing evidence and seller conversations together in an interactive panel.

## What it does

- Turns buying briefs into editable searches, with research, must-haves and preferences.
- Uses optional locale hints and saved preferences for currency and regional marketplace defaults, while preserving explicit choices.
- Compares suitable listings using their specifications, condition, asking prices and saved evidence.
- Keeps photos, price history, shortlists and feedback so you can pick up where you left off.
- Supports one-off searches and recurring checks through your host's browser, background agents and scheduling tools.
- Prepares seller messages and collection arrangements for your review. Sending requires approval of the exact message; a saved draft never contacts a seller.

Goodfinds recognizes Facebook Marketplace, eBay, Vinted, Gumtree, UK Auto Trader and Craigslist, plus CarGurus US, Poshmark US, Depop US/UK, Mercari US, Cars.com US and Autotrader US. New-search defaults use country, category and collection/delivery preference; saved choices and explicit currencies take precedence. Available collection and contact routes differ by marketplace. All marketplaces use host browser controls for navigation, listing inspection and evidence import. Read [marketplace validation](docs/marketplace-validation.md) for current integration coverage and limitations, and the [US expansion test set](docs/us-marketplace-validation.md) for the new routes.

## Run locally

Source builds require Rust 1.92 or later, a C compiler, and Bun 1.4.2 or later for the UI and shared contracts. Installed plugins need none of these tools.

```sh
bun install
bun run build
bun start
```

Open the device-local URL printed by the server to use the panel. New live workspaces start empty; demo mode supplies fictional searches and listings. Use `bun run dev` for panel development.

To build the Codex and Claude packages together:

```sh
bun run package
bun run package:check
```

All packages contain the same native Rust executable with SQLite and the UI embedded:

| Host                         | Package in `dist/`                                             | Installation                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Codex                        | `goodfinds-marketplace-<version>-codex-<target>.zip`           | Load the extracted package through local plugin support. The unpacked build is `dist/goodfinds-marketplace`.                   |
| Claude plugins / Claude Code | `goodfinds-marketplace-<version>-claude-<target>.zip`          | Upload through Customize → Plugins, or load `dist/goodfinds-marketplace-claude` with Claude Code's `--plugin-dir`.             |
| Claude Desktop Chat          | `goodfinds-marketplace-<version>-claude-desktop-<target>.mcpb` | Settings → Extensions → Advanced settings → Install extension. Install the companion Claude plugin ZIP for the shopping skill. |

The Codex and Claude plugin ZIPs include the [marketplace-shopping skill](skills/marketplace-shopping/SKILL.md). Claude's Desktop extension connects the local server to Chat; uploading a plugin alone does not connect its local server to Chat. Host support differs: browser actions need compatible browser tools, background collection needs native agents, and recurring checks need host scheduling. Goodfinds reports unavailable capabilities rather than claiming they ran. See [installation and packaging](docs/packaging.md) for the complete paths and limitations.

Each package targets one operating system and CPU, recorded in its ZIP filename. Packaging defaults to the build machine. macOS, Windows and Linux targets are configured for ARM64 and x64; cross-compilation requires the target linker and SDK. See [packaging](docs/packaging.md) for target selection and platform requirements. Validate each package on its target platform before distribution.

## Your data

Searches, evidence and conversations stay in the local workspace at `~/.local/share/goodfinds`. Set `GOODFINDS_WORKSPACE_DIR` to use another location. Demo initialization uses fictional data and never reads the live database. Marketplace credentials and browser sessions remain separate from saved searches.

```sh
./dist/goodfinds-marketplace/server/goodfinds backup --db /absolute/path/workspace.sqlite --output /absolute/path/new-backup
./dist/goodfinds-marketplace/server/goodfinds restore --input /absolute/path/new-backup --output /absolute/path/new-workspace
```

Backups include committed databases, cached media and connection checks, with integrity verification. Restore creates a new directory. Host schedules and credentials remain with the host. Development output, builds, local databases and secrets are excluded from Git.

## Development

The TypeScript UI and Rust server share validated JSON contracts generated from `packages/contracts`. A contract change is checked on both sides of the MCP interface. Start with [server architecture](docs/server-architecture.md), [interface design](docs/ui-design.md) and [domain vocabulary](CONTEXT.md). The [roadmap](docs/roadmap.md) tracks open work. The [documentation guide](docs/README.md) indexes the public guides and explains where internal notes belong.

```sh
bun run docs:generate # after changing shared state definitions
bun run check
bun run test # builds the native test driver before running the application suite
bun run test:native
```

Validation includes a focused seller-send specification using a pinned Lean toolchain. Install [elan](https://lean-lang.org/install/) and follow the [formal model guide](formal/README.md). The model checks permission and reconciliation guarantees; live browser integrations require separate validation.

## Website

The product site uses static HTML, CSS and small JavaScript modules in `website/`, served by Cloudflare Workers at [goodfinds.thirdtechapps.com](https://goodfinds.thirdtechapps.com). It has no framework, external fonts, analytics or build step. The marketplace carousel shows curated example searches and pauses for interaction and reduced-motion preferences.

```sh
bun install --frozen-lockfile
bun run site:dev
bun run site:check # validate the deployment without publishing
```

To publish the current local website, authenticate with `bunx wrangler login` using the account that owns the configured domain, then run `bun run site:deploy`. The custom domain in `wrangler.site.jsonc` lets Wrangler provision DNS and HTTPS. Deployment uploads only `website/` and is independent of Git pushes; there is no automatic deployment on push. Review the site before running the deployment command.
