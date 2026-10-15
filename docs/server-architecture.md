# Server architecture

Goodfinds runs a native Rust server with bundled SQLite. The React UI and shared Zod contracts remain TypeScript. Read [CONTEXT.md](../CONTEXT.md) for domain meanings and [packaging](packaging.md) for build dependencies, targets and distribution limits.

## Runtime and contracts

[workspace.rs](../apps/server/src/workspace.rs) owns command transactions, optimistic revisions and retry receipts. Listing, search, seller and connection modules operate on its `Workspace`; they do not start another database connection or asynchronous task inside a command. Network operations and host transport live outside that synchronous boundary. `bun run architecture:check` checks this separation.

[storage.rs](../apps/server/src/storage.rs) opens databases and loads configuration. MCP, CLI and the loopback preview call the same native application. [media.rs](../apps/server/src/media.rs) owns private, content-addressed files. Marketplace browsing runs through the host browser; the native server validates and persists imported evidence.

[packages/contracts](../packages/contracts/package.json) supplies the UI's types, schemas, lifecycle descriptions and tool names. The build exports JSON schemas and tool metadata to `apps/server/data/contracts.json`; [contracts.rs](../apps/server/src/contracts.rs) embeds and validates them. Rust also enforces semantic guards that JSON Schema cannot express, such as matching an observed listing URL to its ID. Update both those guards and their contract tests when changing an interface.

Run `bun run contracts:generate` after editing shared contracts, and `bun run contracts:check` to verify the committed export. Generation uses UTC regardless of the developer's local timezone, so schema defaults and the packaged contracts remain reproducible.

Contract generation reads the shared schemas in `packages/contracts`, tool metadata in `packages/contracts/data/tool-metadata.json`, and the native SQLite schema. Tests exercise Rust directly through `apps/server/examples/test-driver.rs` or the native MCP executable. The driver is built only with the `test-support` feature; plugin builds exclude it. UI development and package smoke checks use the native executable.

## Domain and storage

`workspace.sqlite` stores buyer configuration, evidence and workflow state; `connections.sqlite` stores connection checks. [storage.rs](../apps/server/src/storage.rs) initializes the current schema and rejects unsupported versions. New live workspaces have no searches or confirmed location. New sample workspaces initialize independent databases from bundled fictional data without reading live data. Schema version 1 is the sole supported workspace and backup version. Its canonical SQL contains the complete current schema. Only an empty, unversioned database can be initialized; other versions and removed record fields are rejected without conversion. There are no upgrade, downgrade or backfill paths. Resetting an existing workspace requires explicit authorization to erase its data.

The workspace writer transaction commits related configuration changes, alert withdrawals, workflow updates, leases and operation receipts together. Reads use deferred transactions after initial configuration has been saved. Querying status projects expired work without persisting reconciliation; lifecycle commands reconcile under the writer lock.

Entity revisions advance only for changed entities. Retained deletion records prevent optimistic-lock tokens from resetting. Search runs and seller conversations have independent versions. An operation receipt stores the request ID, argument hash and result in the mutation transaction: an exact retry returns the original resource result and a fresh panel snapshot; conflicting reuse fails.

SQLite commands run synchronously under one writer lock. The request checks cancellation before committing; failed or cancelled commands roll back their changes and receipts together. Asynchronous HTTP calls do not hold that transaction. Shutdown closes native transports and their tasks.

Backups capture committed SQLite data, immutable media and connection checks, verify checksums and integrity, and publish a new directory atomically. Restore accepts the supported workspace format. Credentials and host schedules stay with their host. See [backup and restore commands](../README.md#your-data).

## Commands and naming

[operations.ts](../packages/contracts/src/operations.ts) owns input/output schemas and annotations; [tool-names.ts](../packages/contracts/src/tool-names.ts) maps operations to MCP tools. MCP, preview and backend use these definitions. Model results contain compact changed resources and action descriptors; full panel snapshots use app metadata. Listing summaries are paginated and full evidence is fetched on demand. Encoded video payloads do not belong in model output.

Use the vocabulary in [CONTEXT.md](../CONTEXT.md). Goodfinds is the product, `goodfinds-marketplace` the plugin, `marketplace-shopping` the skill and `goodfinds` the MCP namespace. Rust modules use snake_case filenames; shared TypeScript modules use kebab-case filenames. SQL uses plural tables and snake_case columns. Resource IDs name their target, timestamps end in `_at`, millisecond deadlines identify `_ms`, and JSON columns name their contents.

New buying setup uses `get_setup_context` to read settings, revision tokens, saved identity indexes and an optional category template without building a full listing snapshot. Saving a new search also saves its initial monitoring preference in the same transaction: recurring at the saved cadence, defaulting to 120 minutes in a new workspace. An explicit one-off or custom timing choice can be supplied at creation; edits retain the saved monitoring choices. Host registration remains a separate verified step.

The packaged `schema TOOL` command exposes the exact input schema without a mutation. Validation reports bounded field paths together, and the persistent JSON helper requires piped input to avoid terminal line truncation.

Tools follow `<verb>_goodfinds_<resource>`. `get` and `list` read; `save` and `set` edit state; `record` and `report` persist observations. `request` records intent, `claim` acquires ownership, `renew` extends a lease, `prepare` creates reviewable work and `issue` grants a checked permit. Keep intent, ownership, permission and observed completion distinct.

## Host execution and monitoring

The buying chat requests durable work and dispatches host-native workers. The plugin supplies neither an agent runtime nor an internal scheduler or notification transport. A host message requests dispatch; it does not establish that a worker started. Dispatch, model routing and recovery follow [background work](../skills/marketplace-shopping/references/background-work.md); execution profiles are defined in [worker-execution.ts](../packages/contracts/src/worker-execution.ts).

Independent saved searches can execute in parallel. Each search reuses its active run and permits one live worker for that run; the workspace writer transaction makes competing claims atomic. Search workers claim their actual identity, renew leases and import incremental evidence. Cancellation, expiry and changed briefs fence later writes. Connection-check completion validates ownership, expiry, browser choice and cancellation in the writer transaction. Cancellation before evidence commits prevents that write; cancellation after commitment does not erase a valid observation. Worker model metadata is caller-reported, not host attestation, and absent metadata stays unknown.

Monitoring preferences, dispatchers and observed host schedules are separate. Shared dispatchers preserve each search's timing, original chat and notification settings. Only representable unions of wake-up times share a schedule. Due-run reservations use the writer lock, durable wake-up receipts and deterministic local occurrence IDs; active workers are reused and partial coverage can resume. Quiet hours and the compiled timing plan gate scheduled work. A shared pause fences starts, leases and imports for all members. Read-only status cannot create or resume a schedule.

## Evidence and seller actions

Listing evaluation separates suitability from comparative asking-price evidence. Price cohorts preserve model, currency and price-period distinctions. Missing peers cannot establish a bargain or hide an otherwise suitable listing. Listing discovery tracks the earliest run per search; repeated sightings do not increase unique counts. Media repair and travel-cache updates never refresh fact, price or availability timestamps. See [listing observations](../skills/marketplace-shopping/references/observations.md) for evidence meanings and statistical limits.

Model exclusions derive from explicit buyer feedback and verified identity, apply consistently to matching and query planning, and retain scope and Undo. A reasonless dismissal affects one listing. Product-search covers use observed official photos cached in the workspace; bundled covers are generic illustrations. Cover follow-up is a read-only queue, including identified searches with no listings. See [search covers](../skills/marketplace-shopping/references/search-covers.md) for acquisition and reuse.

Browser control, marketplace sign-in and listing contact are independent, expiring observations. Location acquisition runs on the user's device after a user action, with an area preview and confirmation; cloud/server IP lookup cannot establish the buyer's location. Free client reverse geocoding accepts fresh consented device coordinates only. Keep manual entry available and never store raw IP addresses or continuous location history. Provider requirements and host procedures are in [platforms, location and feedback](../skills/marketplace-shopping/references/platforms-location-feedback.md).

Journey evidence is cached by confirmed origin and destination, including country and available coordinates. Origin changes invalidate old estimates. Traffic estimates expire after one day; explicitly typical estimates after seven days. Town-level estimates near a travel limit remain conditional. The host supplies browser routing evidence; the plugin has no shared routing API key. See [journeys](../skills/marketplace-shopping/references/journeys.md).

Seller actions snapshot the buyer's reviewed wording. Claiming an action does not permit sending: a fresh single-use permit checks identity, contact eligibility, availability, duplicate evidence and collection expiry. Interrupted sends require reconciliation in the same thread, never another permit for the same immutable action. A confirmed purchase fulfils linked search goals and fences automatic work. Follow [seller conversations](../skills/marketplace-shopping/references/seller-conversations.md) for execution and [marketplace validation](marketplace-validation.md) for unverified integrations.

## State definitions and verification

Shared lifecycle definitions own meanings, invariants, events, guards and recovery. Mutation handlers use those guards with an injected clock and context. Workflow descriptors are computed response views, never persisted authorization. Availability, evidence, reading state, suitability, conversation phase and buying outcome remain independent.

`bun run docs:generate` produces the packaged [state reference](../skills/marketplace-shopping/references/state-model.md). `bun run docs:check` validates references and freshness; packaging also requires it. Edit shared definitions rather than the generated file. Tests check guard parity, transaction behavior and recovery; generated prose does not establish correctness.

The [Lean specification](../formal/README.md) proves properties of an abstract seller protocol. Model comparisons and native tests sample implementation agreement; they do not formally verify the Rust server or host browser. Keep consequential boundaries and invariants here, host procedures in skill references, interface rules in [UI design](ui-design.md), and unfinished requirements in the [roadmap](roadmap.md).

## Coordination and recovery

Lease renewals and active progress updates return their validated run and workflow without constructing panel state. They retain the same transaction, ownership, version, cancellation, brief and scheduled-execution guards. Terminal progress still performs its existing completion work. Panel progress polls use a content revision that excludes lease-only changes; those changes update the displayed run version and owner without rebuilding the workspace.

`get_goodfinds_search_recovery` reads one exact run, its current brief and version-pinned pages of unfinished queries and verification references. `get_goodfinds_runtime_context` exposes the installed workflow contract and expiring, connection-scoped capability observations. Reports are caller observations, not host attestations or execution permissions. Schedule compatibility diagnosis preserves paused bindings.

MCP pending-alert reads use stable keyset cursors and recheck qualification against the full current peer population. A page may be empty while returning a cursor. Acknowledgement is atomic, receipted and idempotent for already delivered IDs. Failed or uncertain presentation remains pending; the server supplies no notification transport.

Schema version 1 includes a small sequenced completion stream that records completed, interrupted and deferred run transitions and alert creation in the same transaction as the resources, using SQLite triggers. No automatic retention or receipt deletion is configured. Consumers persist the returned stream cursor only after processing, reread referenced resources and tolerate duplicates. Restored backups receive a fresh stream identity. Invalid/foreign or truncated cursors return `cursor_gap` and require resynchronization. Reads project lease expiry without writing; its interruption event is recorded when normal command reconciliation persists it. Seller sends remain exclusively behind their exact-message permit and reconciliation protocol.

Scoped listing queries omit activity and historical analytics. Current rows for the complete relevant product population still determine ranking and comparison pools; exact detail reads hydrate only the requested history. Global relationship identities and recommendation ordering are retained. See [performance measurements](server-performance.md) for diagnostics and regression budgets.
