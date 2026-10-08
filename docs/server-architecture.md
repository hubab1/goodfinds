# Server architecture

Goodfinds runs an Effect 4 backend on Bun. Pure domain calculations and shared Zod contracts remain ordinary TypeScript. Effect owns I/O failures, resources, cancellation and shutdown; the standard MCP SDK owns transport. Read [CONTEXT.md](../CONTEXT.md) for domain meanings and the [README](../README.md#run-locally) for building and packaging.

## Module boundaries

Domain modules under `apps/server/src` own searches, listings, sellers, connections and workspace behavior. They depend on domain-owned repository interfaces, never platform adapters, SQLite handles, filesystem/process APIs or environment reads. `platform/` implements those adapters; `entrypoints/` composes them. `bun run architecture:check` enforces the boundary.

[backend.ts](../apps/server/src/entrypoints/backend.ts) supplies the application Layer for MCP and preview. [workspace-layer.ts](../apps/server/src/entrypoints/workspace-layer.ts) assembles transaction-local services around one scoped SQLite connection before entering a writer transaction. Services capture their dependencies during construction, so callers do not supply storage repeatedly.

`packages/contracts` is the shared source of validated transport schemas, pure lifecycle definitions and domain meanings. The panel consumes those contracts and workflow projections; the server rechecks every command under its writer lock. A displayed available action is not authorization to execute it later. Research-generated forms remain declarative data rendered by fixed controls, never executable UI code.

## Domain and storage

`workspace.sqlite` stores buyer configuration, evidence and workflow state; `connections.sqlite` stores connection checks. [database-schema.ts](../apps/server/src/platform/database-schema.ts) owns schema initialization and supported additive upgrades; unsupported schemas are rejected. New live workspaces have no searches or confirmed location. New sample workspaces initialize independent databases from bundled fictional data without reading live data. Existing saved workspaces are preserved.

The workspace writer transaction commits related configuration changes, alert withdrawals, workflow updates, leases and operation receipts together. Reads use deferred transactions after initial configuration has been saved. Querying status projects expired work without persisting reconciliation; lifecycle commands reconcile under the writer lock.

Entity revisions advance only for changed entities. Retained deletion records prevent optimistic-lock tokens from resetting. Search runs and seller conversations have independent versions. An operation receipt stores the request ID, argument hash and result in the mutation transaction: an exact retry returns the original resource result and a fresh panel snapshot; conflicting reuse fails.

[sqlite.ts](../apps/server/src/platform/sqlite.ts) is the synchronous Effect adapter for Bun transactions. It rejects suspended asynchronous work and interrupts that fiber before rollback so it cannot write later. One managed runtime per server releases resources on cancellation and shutdown.

Backups capture committed SQLite data, immutable media and connection checks, verify checksums and integrity, and publish a new directory atomically. Restore accepts the supported workspace format; it does not import arbitrary legacy data. Credentials and host schedules stay with their host. See [backup and restore commands](../README.md#your-data).

## Commands and naming

[operations.ts](../packages/contracts/src/operations.ts) owns input/output schemas and annotations; [tool-names.ts](../packages/contracts/src/tool-names.ts) maps operations to MCP tools. MCP, preview and backend use these definitions. Model results contain compact changed resources and prerequisites; full panel snapshots use app metadata. Listing summaries are paginated and full evidence is fetched on demand. Encoded video payloads do not belong in model output.

Use the vocabulary in [CONTEXT.md](../CONTEXT.md). Goodfinds is the product, `goodfinds-marketplace` the plugin, `marketplace-shopping` the skill and `goodfinds` the MCP namespace. Modules use kebab-case filenames and `*.test.ts`; SQL uses plural tables and snake_case columns. Resource IDs name their target, timestamps end in `_at`, millisecond deadlines identify `_ms`, and JSON columns name their contents.

Tools follow `<verb>_goodfinds_<resource>`. `get` and `list` read; `save` and `set` edit state; `record` and `report` persist observations. `request` records intent, `claim` acquires ownership, `renew` extends a lease, `prepare` creates reviewable work and `issue` grants a checked permit. Keep intent, ownership, permission and observed completion distinct.

## Host execution and monitoring

The buying chat requests durable work and dispatches host-native workers. The plugin supplies neither an agent runtime nor an internal scheduler or notification transport. A host message requests dispatch; it does not establish that a worker started. Dispatch, model routing and recovery follow [background work](../skills/marketplace-shopping/references/background-work.md); execution profiles are defined in [worker-execution.ts](../packages/contracts/src/worker-execution.ts).

Search workers claim their actual identity, renew leases and import incremental evidence. Cancellation, expiry and changed briefs fence later writes. Connection-check completion validates ownership, expiry, browser choice and cancellation in the writer transaction. Cancellation before evidence commits prevents that write; cancellation after commitment does not erase a valid observation. Worker model metadata is caller-reported, not host attestation, and absent metadata stays unknown.

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

The [Lean specification](../formal/README.md) proves properties of an abstract seller protocol. TypeScript comparisons sample implementation agreement; they do not formally verify the server or host browser. Keep consequential boundaries and invariants here, host procedures in skill references, interface rules in [UI design](ui-design.md), and unfinished requirements in the [roadmap](roadmap.md).
