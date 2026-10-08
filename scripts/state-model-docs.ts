import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { operationNames } from "@goodfinds/contracts/tool-names";
import { operations } from "@goodfinds/contracts/operations";
import {
  searchStates,
  searchEvents,
  searchGuards,
  searchPhases,
} from "@goodfinds/contracts/search-run-model";
import {
  sellerStates,
  sellerEvents,
  sellerGuards,
  sellerActionStatuses,
} from "@goodfinds/contracts/seller-action-model";
import {
  listingDimensions,
  listingEvents,
  listingGuards,
} from "@goodfinds/contracts/listing-model";
import { conversationSchema } from "@goodfinds/contracts/seller-conversation";
import {
  connectionCheckStates,
  connectionCheckStatuses,
  connectionCheckTools,
} from "@goodfinds/contracts/connection-checks";
import { executionProfiles, workerTasks } from "@goodfinds/contracts/worker-execution";
import type {
  EventDefinition,
  GuardDefinition,
  StateDefinition,
} from "@goodfinds/contracts/workflow-model";
import formalProperties from "../formal/properties.json" with { type: "json" };

export const stateModelPath = resolve(
  import.meta.dir,
  "../skills/marketplace-shopping/references/state-model.md",
);
const source = "packages/contracts/src";
type DocumentedModel = {
  name: string;
  anchor: string;
  file: string;
  states: Record<string, StateDefinition>;
  events: Record<string, EventDefinition>;
  guards: Record<string, GuardDefinition>;
  virtual: string[];
};
export const models: DocumentedModel[] = [
  {
    name: "Search runs",
    anchor: "search-runs",
    file: "search-run-model.ts",
    states: searchStates,
    events: searchEvents,
    guards: searchGuards,
    virtual: ["absent"],
  },
  {
    name: "Seller actions",
    anchor: "seller-actions",
    file: "seller-action-model.ts",
    states: sellerStates,
    events: sellerEvents,
    guards: sellerGuards,
    virtual: ["idle"],
  },
  {
    name: "Listings",
    anchor: "listings",
    file: "listing-model.ts",
    states: {},
    events: listingEvents,
    guards: listingGuards,
    virtual: ["listing"],
  },
];
/** Reject dangling registry references before writing or checking documentation. */
export function validateStateModels(supplied: readonly DocumentedModel[] = models) {
  for (const model of supplied) {
    for (const [name, state] of Object.entries(model.states)) {
      if (!state.meaning || !state.invariant || !state.recovery)
        throw new Error(`${model.name}.${name}: incomplete state documentation`);
    }
    for (const [name, guard] of Object.entries(model.guards)) {
      if (!guard.message || !guard.recovery)
        throw new Error(`${model.name}.${name}: incomplete guard documentation`);
    }
    const states = new Set([...Object.keys(model.states), ...model.virtual]);
    const guards: Record<string, GuardDefinition> = model.guards;
    const events: Record<string, EventDefinition> = model.events;
    for (const [name, event] of Object.entries(events)) {
      if (event.execution_profile && !Object.hasOwn(executionProfiles, event.execution_profile))
        throw new Error(
          `${model.name}.${name}: unknown execution profile ${event.execution_profile}`,
        );
      for (const state of [...event.from, ...event.to])
        if (!states.has(state)) throw new Error(`${model.name}.${name}: unknown state ${state}`);
      for (const guard of event.guards)
        if (!guards[guard]) throw new Error(`${model.name}.${name}: unknown guard ${guard}`);
      for (const edge of event.diagram ?? []) {
        if (!event.from.includes(edge.from) || !event.to.includes(edge.to))
          throw new Error(`${model.name}.${name}: invalid diagram transition`);
      }
      if (
        event.operation &&
        (!Object.hasOwn(operations, event.operation) || !operationNames[event.operation].length)
      )
        throw new Error(`${model.name}.${name}: unknown public operation ${event.operation}`);
      if (event.operation) {
        const schema = z.toJSONSchema(operations[event.operation].input);
        for (const input of event.inputs) {
          const path = input.split(" ")[0]?.split("/")[0]?.split("=")[0];
          let current: z.core.JSONSchema.JSONSchema = schema;
          for (const field of path?.split(".") ?? []) {
            const next = current.properties?.[field];
            if (!next || typeof next === "boolean")
              throw new Error(`${model.name}.${name}: unknown input ${input}`);
            current = next;
          }
        }
      }
    }
  }
  for (const [names, states] of [
    [searchPhases, searchStates],
    [sellerActionStatuses, sellerStates],
    [connectionCheckStatuses, connectionCheckStates],
  ] as const) {
    if (names.join() !== Object.keys(states).join())
      throw new Error("State schema and registry disagree");
  }
}
const cell = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");
function table(headers: string[], rows: string[][]): string {
  return [headers, headers.map(() => "---"), ...rows]
    .map((row) => `| ${row.map(cell).join(" | ")} |`)
    .join("\n");
}
function statesTable(states: Record<string, StateDefinition>) {
  return table(
    ["State", "Meaning", "Safety context", "Recovery"],
    Object.entries(states).map(([name, s]) => [`\`${name}\``, s.meaning, s.invariant, s.recovery]),
  );
}
export function renderStateModel(): string {
  validateStateModels();
  const lines = [
    "# State model and available actions",
    "",
    "<!-- Generated by bun run docs:generate. Edit the shared model definitions, not this file. -->",
    "",
    "This reference is generated from executable shared definitions. `workflow.actions` is the authoritative guidance: `available` means known guards pass, `requires_input` means input or evidence is missing, and `blocked` means a known guard fails. Each descriptor names an event, canonical operation/tool, required inputs, conditions, stable blocker codes and an execution profile with native worker launch settings. `allowed_actions` is a compatibility list of tools that can be proposed, including tools that still need input; it is not execution permission.",
    "",
    "Read `search_workflows[search_id]` and `search_run_workflows[run_id]` in search context, or the run map in full progress reads. `progress_only: true` keeps polling compact and returns an empty workflow map. Mutation results include `workflow`. Read `get_goodfinds_listing` with optional `search_id` for scoped assessments and action guidance. Workflow fields are derived response views; SQLite persists the existing domain documents, versions and leases, not these views. The clock is supplied explicitly to guards and projections.",
    "",
    "A fresh `execution.send_permitted: true` from `issue_goodfinds_message_send_permit` is the only browser send permit. It applies once to the saved exact text and verified identity. A descriptor, draft, claim, host handoff or replayed response cannot grant another permit. User review is a caller/host responsibility; the server does not infer authorization from lifecycle state.",
    "",
    "## Worker model routing",
    "",
    "Source: `packages/contracts/src/worker-execution.ts`. These profiles choose the host agent doing the surrounding evidence work; MCP tools still execute ordinary server code. Apply `action.execution.spawn` when dispatching new worker work. Existing workers keep their model across renewal, progress and persistence calls; those calls never require spawning an agent or switching models. The host must honor the settings; MCP metadata alone cannot switch the calling model.",
    "",
    table(
      ["Profile", "Launch overrides", "Scope"],
      Object.entries(executionProfiles).map(([name, profile]) => [
        `\`${name}\``,
        Object.keys(profile.spawn).length
          ? `\`${JSON.stringify(profile.spawn)}\``
          : "Omit model and reasoning overrides; inherit the buying chat",
        profile.meaning,
      ]),
    ),
    "",
    table(
      ["Work", "Profile", "Completion"],
      Object.entries(workerTasks).map(([name, task]) => [
        `\`${name}\``,
        `\`${task.profile}\``,
        task.meaning,
      ]),
    ),
    "",
    "Collection workers start with bounded explicit context (`fork_turns: none`) so the host can apply the requested model override. Supply the saved brief, query/check scope, IDs, shared paths, installed skill and browser route. Verify the worker's actual browser and media tools. If overrides or the requested model are unavailable, omit overrides, inherit the buying chat and report the fallback; preserve existing interruption handling when delegation or browser access is unavailable. Connection checks use the same host-subagent dispatch policy and record unavailable when delegation cannot start; there is no foreground browser fallback or plugin-owned agent runtime.",
    "",
    "Keep unknowns and conflicts in saved evidence. The buying chat handles interpretation, final comparisons, seller wording/sends and scheduling. Collection workers return specific unresolved questions without loosening requirements or guessing. A conflicting listing's observation action uses the chat profile; media recovery can still use collection. Seller check claims/results use collection; send execution retains chat settings and its existing reviewed permit.",
    "",
    "Search, connection-check and seller claim inputs accept optional `execution: {profile, model, reasoning_effort?}` containing actual host-reported settings. These are stored with the worker claim or seller action and survive reconnects. They are not a recommendation, a model-switch mechanism, proof of inference quality or a send permission. Omit unknown settings; existing records remain valid without them. A resumed search clears the old worker; a new seller executor replaces its execution record.",
    "",
  ];
  lines.push(
    "## Connection checks",
    "",
    "Source: `packages/contracts/src/connection-checks.ts`.",
    "",
    statesTable(connectionCheckStates),
    "",
    table(
      ["Tool", "Purpose"],
      connectionCheckTools.map((tool) => [`\`${tool.name}\``, tool.description]),
    ),
    "",
    "Settings queues a check and sends a host message requesting native subagent dispatch. Only a claim moves queued to running. Parent dispatch failure may interrupt an unclaimed job; running completion/interruption requires the owning worker. Queued dispatch and worker leases expire after two minutes; claimed checks also have a five-minute maximum. Reuse running workers, preserve the selected browser, and stop on cancellation or expiry. Native identity and execution metadata are caller-reported audit evidence, not attestation. Read [connection-check execution](background-work.md#connection-checks) before dispatch.",
    "",
  );
  for (const model of models) {
    lines.push(`## ${model.name}`, "", `Source: \`${source}/${model.file}\`.`, "");
    if (Object.keys(model.states).length) lines.push(statesTable(model.states), "");
    if (model.anchor === "listings") {
      for (const [dimension, states] of Object.entries(listingDimensions))
        lines.push(`### ${dimension}`, "", statesTable(states), "");
      lines.push(
        "Assessments reuse the existing evaluator, scoped feedback and prepared buying next steps. Gallery capture uses the same calculation as the media repair queue. Saved media never establishes image/video review or refreshes price/availability timestamps.",
        "",
      );
    }
    lines.push(
      "### Action meanings",
      "",
      table(
        ["Action", "Tool", "Purpose"],
        Object.entries(model.events).map(([name, event]) => [
          `\`${name}\``,
          event.operation
            ? `\`${operationNames[event.operation][0]}\``
            : "Internal lifecycle event",
          event.meaning,
        ]),
      ),
      "",
    );
    lines.push(
      "Use the returned workflow for current transitions, required inputs and blockers; [tool contracts](tool-contracts.md) explains the wire format. This reference explains why actions exist and how to recover. Updates evaluate query changes in the same call. Terminal retries may return an existing result without transitioning.",
      "",
    );
    lines.push(
      table(
        ["Blocker code", "Meaning", "Recovery"],
        Object.entries(model.guards).map(([code, guard]) => [
          `\`${code}\``,
          guard.message,
          guard.recovery,
        ]),
      ),
      "",
    );
  }
  lines.push(
    "## Lifecycle diagrams",
    "",
    "These generated diagrams are navigation aids for the primary paths. TypeScript guards define accepted transitions; workerless updates and terminal retries also exist. A separate Lean model checks seller permission safety.",
    "",
    ...models
      .filter((m) => Object.keys(m.states).length)
      .flatMap((model) =>
        ["```mermaid", "stateDiagram-v2"].concat(
          Object.entries(model.events).flatMap(([name, event]) =>
            (event.diagram ?? []).map(
              (edge) =>
                `  ${edge.from} --> ${edge.to}: ${name}${edge.label ? ` / ${edge.label}` : ""}`,
            ),
          ),
          ["```", ""],
        ),
      ),
    "## Independent dimensions",
    "",
    `Conversation phase: ${conversationSchema.shape.phase.options.map((p) => `\`${p}\``).join(", ")}. Reply facets and observed messages determine phase; an accepted offer is not a completed purchase.`,
    "",
    `Buying outcome: ${conversationSchema.shape.outcome.options.map((p) => `\`${p}\``).join(", ")}. Only a recorded \`bought\` outcome fulfils linked search goals. Collection plan status and seller action status remain independent.`,
    "",
    "Saved-search eligibility, monitoring preference and observed host schedule are separate. An enabled search or completed run does not establish a running automation. Scheduled execution still preflights current timing, quiet hours and goal eligibility with `check_goodfinds_scheduled_search`.",
    "",
    "## Recovery examples",
    "",
    "- `category_query_unchecked`: complete a broad category query and set `phase: verifying` together, using the current version and worker identity when claimed.",
    "- `lease_expired`: read current progress, preserve results and resume with a new worker. An expired seller send requires a reconciliation claim, never another permit.",
    "- `permit_already_issued`: inspect the same verified seller thread and report the exact observed outgoing text or verified absence. Do not repeat the send.",
    "- A listing can be suitable for one search, unsuitable or dismissed for another, and still have conflicting verification evidence. Read the selected search's assessment before deciding.",
    "",
    "## Maintaining this reference",
    "",
    "The focused Lean specification checks seller permission and reconciliation safety; its developer guide is `formal/README.md` in the source repository. The table below is generated from its proof inventory. Proofs establish properties of that abstract model; executable comparisons sample TypeScript agreement. Browser observations, host authorization and storage internals remain assumptions or separately tested behavior. Search runs, connection checks and receipts rely on TypeScript guards and integration tests.",
    "",
    table(
      ["Model / property", "Checked claim", "Lean theorem"],
      formalProperties.models.flatMap((model) =>
        model.properties.map((property) => [
          `${model.name} / ${property.id}`,
          property.meaning,
          property.theorems.map((name) => `\`${model.namespace}.${name}\``).join(", "),
        ]),
      ),
    ),
    "",
    "When changing seller permission or reconciliation semantics, update TypeScript, Lean and the explanation together. Preserve proof obligations unless the intended requirement changes. `bun run formal:check` builds and audits seller proofs, rechecks them with Lean's kernel checker, and compares the executable seller model with TypeScript. Other lifecycle changes require their TypeScript tests and generated explanations. The property inventory and state meanings generate this reference; do not hand-copy transition matrices or tool schemas into prose.",
    "",
    "Edit shared model meanings, invariants, event/guard definitions and executable guard logic together. Run `bun run docs:generate`, then `bun run check` and the domain tests. `docs:check` validates references and fails when this file is stale; packaging checks freshness and includes this reference in the skill. Tests cover guard/enforcement parity and the distinctions above. Design rationale lives in `docs/server-architecture.md`.",
    "",
  );
  return lines.join("\n");
}
export async function formattedStateModel(): Promise<string> {
  const child = Bun.spawn(
    [process.execPath, "--bun", "oxfmt", "--stdin-filepath", stateModelPath],
    {
      cwd: resolve(import.meta.dir, ".."),
      stdin: new TextEncoder().encode(renderStateModel()),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [output, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) throw new Error(`Cannot format generated state reference: ${error}`);
  return output;
}
export async function checkStateModelDocs(path = stateModelPath): Promise<void> {
  const expected = await formattedStateModel();
  const actual = await readFile(path, "utf8");
  if (actual !== expected)
    throw new Error("State model documentation is stale. Run bun run docs:generate.");
}
