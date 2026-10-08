# Open work

These requirements are not established capabilities. Read [marketplace validation](marketplace-validation.md) for current integration coverage and the observations needed before claiming live support. Current host procedures belong to the [marketplace-shopping skill](../skills/marketplace-shopping/SKILL.md).

## Shared budget intent

Define a shared budget descriptor for target, maximum or range, including currency, price period and cost scope. Generic fields and offer defaults currently express parts of this meaning independently. Preserve “around £200” without inventing a hard ceiling; setup, display, matching and offer defaults must agree. A requested discount from retail price needs sourced retail evidence and a separate comparison rule from peer asking prices.

## MCP alert acknowledgement

The durable outbox supports listing and acknowledgement through the CLI, and imports return pending alerts. Add MCP operations for reading later pending alerts and acknowledging presentation, with stable IDs, pagination and idempotent acknowledgement. Failed or uncertain presentation must remain pending across restart. External notifications still depend on host capabilities.

## Schedule upgrades

Verify a workflow contract version and that saved schedule prompts resolve the installed skill. Reconcile stale bindings in the original buying chat, preserving pause state, cadence, thread and notification settings. Include an upgrade test with a paused schedule; development work must not activate buyer monitoring.

## Host capability summary

Add an observed host-level summary for native panel support, browser control, delegation, local files and scheduling. Marketplace collection capabilities and browser observations already exist, but server health does not establish host support. Keep unknown capabilities unknown and verify panel and chat-only recovery paths.

## Live integrations and release validation

Complete the [live acceptance procedures](marketplace-validation.md#remaining-live-acceptance-work), including eBay production entitlements, browser/profile behavior and native-offer inspection. Additional automated collectors need supported collection routes. Validate each distributed executable on its target operating system and architecture; protocol fixtures and successful packaging do not establish live integration support.

## Interview quality

Evaluate model-generated research and questions with unfamiliar categories and ambiguous briefs. Measure unnecessary questions, completion and usefulness of first results. Check that supplied answers and custom requirements survive, questions do not repeat, uncertainty stays distinct from no preference, and deferred hard criteria remain effective. Authored protocol fixtures do not establish interview quality or usability.

Agent-written status and diagnostic text also needs case-by-case editing or structured reason codes. Do not globally replace words in buyer names, seller descriptions or saved evidence to fix interface terminology.
