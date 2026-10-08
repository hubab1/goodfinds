# Checked seller-send specification

Lean checks a focused model of seller permission and reconciliation. TypeScript runs
the server. Proofs establish properties of the model; comparison tests sample whether
production behavior agrees. This does not formally verify the TypeScript server.

## Scope

An interrupted browser send may have succeeded even when its acknowledgement is lost.
The same immutable action must never receive another permission to send. This safety
rule spans claiming, expiry and reconciliation, so checking all modeled finite histories
adds value beyond individual recovery examples.

Search runs, connection checks and command receipts use TypeScript guards and integration
tests. Extend the formal specification only for a precise, consequential guarantee that
justifies a separately maintained model.

## Run the checks

Install [elan](https://lean-lang.org/install/), Lean's toolchain manager. The project
pins Lean in [lean-toolchain](lean-toolchain) and uses only bundled libraries. From the
repository root, run `bun run formal:check`. It builds with warnings treated as failures,
audits theorem dependencies, rechecks compiled declarations with `leanchecker`, and
runs seller comparisons. The check runs in `bun run check` and dedicated CI.

For direct editing:

```sh
cd formal
lake --wfail build
LEAN_NUM_THREADS=1 lake env leanchecker Goodfinds
```

The script also recognizes an isolated elan installation in `.local/elan`. Installation
and build output stay in ignored directories. The script limits kernel replay to one
worker by default to bound memory; set `LEAN_NUM_THREADS` to override it. No Lean code
ships in the production server.

## Checked guarantees

[SellerAction.lean](Goodfinds/SellerAction.lean) defines the abstract protocol.
[SellerActionProofs.lean](Goodfinds/SellerActionProofs.lean) proves invariant preservation
and extends it to arbitrary finite accepted histories. The named obligations and their
human meanings are listed in [properties.json](properties.json) and rendered in the
[generated state reference](../skills/marketplace-shopping/references/state-model.md#maintaining-this-reference).

The obligations cover at most one permit per immutable action, preservation of its
reviewed draft, rejection of another permit or cancellation during uncertainty, lease
fencing, and the validation facts required to record a sent result. `Audit.lean` checks
transitive theorem dependencies, rejecting admitted proofs and custom axioms. Only Lean's
standard logical axioms are allowed; negative tests check that the audit rejects failures.

## How TypeScript and Lean connect

The [development bridge](../scripts/formal-model.ts) builds the model into the native
`seller_action_oracle` executable. The [comparison tests](../tests/formal-seller-action.test.ts)
project TypeScript records into model states, send arrays of state/context/event cases
as JSON on standard input, and compare the JSON next states or rejections on standard
output. They exercise seller guard boundaries and an actual stored history through
permission, expiry, replacement ownership and reconciliation.

The model and TypeScript implementation are written separately. No TypeScript is
translated into Lean, and Lean generates no production TypeScript. The proofs cover
all modeled histories; the implementation comparisons cover only the cases exercised.
An agreement test cannot establish general equivalence or validate a shared assumption.

## Meaning, example and recovery

An action begins after the host obtains review of exact wording. Claiming assigns an
executor. Preparation checks current conditions before issuing permission. The model's
`permits` counter records proof history; it is not a database field. The tests count
actual `send_permitted` responses for the action.

If a worker receives permission and disconnects after clicking Send, wait for expiry,
claim reconciliation and inspect the same thread. Record the observed sent message or
verified absence. Do not issue another permit or cancel away the uncertainty. After
verified absence, another reviewed attempt uses a new action ID. Follow the
[host procedure](../skills/marketplace-shopping/references/seller-conversations.md).

An interrupted send can also be uncertain before a permit was recorded. The model
permits reconciliation of that case without authorizing a send. Reply-check actions are
represented because they share the executor protocol, but never receive send permission.

## Abstraction and trusted boundaries

Route, identity, draft readiness and evidence quality become Boolean facts supplied by
TypeScript validators and the host. A proof that sent requires matching evidence proves
that those facts must be true; it does not prove the validators, truthful observations,
or a real browser send. Draft identity is scoped to one immutable action. Creating a new
action and recording manual history remain outside that history.

The server reconciles expiry before applicable writes; model histories expose that as
an explicit expiry event. Times are integer milliseconds; comparisons use JavaScript-safe
integers and valid ISO timestamps. Storage transactions, faithful serialization, UUID and
lease-token freshness, clocks, host review, browser evidence, Bun and SQLite remain
trusted boundaries or separately tested behavior.

## Documentation and maintenance

TypeScript contracts and services own runtime schemas, guards, persistence and responses.
Lean owns the abstract seller protocol and its safety obligations. Markdown explains
meanings, rationale, examples and recovery. Shared TypeScript definitions generate state
meanings and diagrams; the proof inventory generates the seller claims.

When seller permission or reconciliation semantics change, update the implementation,
model and explanation together. Preserve proof obligations unless the intended requirement
changes. An agent keeping files synchronized does not replace review of whether the
requirement and abstraction are correct. Other lifecycle changes require their TypeScript
tests and generated explanations, with no Lean update.

Run `bun run docs:generate`, then `bun run check` and affected domain tests. Keep successful
execution and recovery examples so an overly restrictive model cannot pass by rejecting
all work. Direct TypeScript tests cover search recovery, connection cancellation during
persistence, receipt replay after later edits and transaction rollback.

See the official [proof validation guide](https://lean-lang.org/doc/reference/latest/ValidatingProofs/)
for the distinction between a valid proof and the meaning of its statement.
