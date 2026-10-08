import { operationNames } from "./tool-names.ts";
import type { OperationName } from "./tool-names.ts";
import { executionPolicy } from "./worker-execution.ts";
import type { ExecutionProfile } from "./worker-execution.ts";

export type Blocker = {
  code: string;
  message: string;
  recovery: string;
  kind: "input" | "blocked";
};
export type ActionDescriptor = {
  event: string;
  operation: OperationName;
  tool: string;
  availability: "available" | "requires_input" | "blocked";
  required_inputs: string[];
  conditions: string[];
  blockers: Blocker[];
  execution: ReturnType<typeof executionPolicy>;
};
export type Workflow = {
  state: string;
  actions: ActionDescriptor[];
  allowed_actions: string[];
  prerequisites: string[];
};
export type StateDefinition = { meaning: string; invariant: string; recovery: string };
export type EventDefinition = {
  operation: OperationName | null;
  from: readonly string[];
  to: readonly string[];
  inputs: readonly string[];
  guards: readonly string[];
  meaning: string;
  execution_profile?: ExecutionProfile;
  diagram?: readonly { from: string; to: string; label?: string }[];
};
export type GuardDefinition = { message: string; recovery: string };
export function blocker(
  guards: Record<string, GuardDefinition>,
  code: string,
  kind: Blocker["kind"] = "blocked",
): Blocker {
  const guard = guards[code];
  if (!guard) throw new Error(`Unknown workflow guard: ${code}`);
  return { code, ...guard, kind };
}
export function describeAction(
  event: string,
  definition: EventDefinition & { operation: OperationName },
  guards: Record<string, GuardDefinition>,
  blockers: Blocker[],
): ActionDescriptor {
  return {
    event,
    operation: definition.operation,
    tool: operationNames[definition.operation][0] ?? definition.operation,
    availability: blockers.some((item) => item.kind === "blocked")
      ? "blocked"
      : blockers.length
        ? "requires_input"
        : "available",
    required_inputs: [...definition.inputs],
    conditions: definition.guards.map((code) => {
      const guard = guards[code];
      if (!guard) throw new Error(`Unknown workflow guard: ${code}`);
      return guard.recovery;
    }),
    blockers,
    execution: executionPolicy(definition.execution_profile ?? "chat"),
  };
}
export function workflow(state: string, actions: ActionDescriptor[]): Workflow {
  return {
    state,
    actions,
    // Compatibility: these tools can be proposed, but may still require input/evidence.
    allowed_actions: [
      ...new Set(actions.filter((a) => a.availability !== "blocked").map((a) => a.tool)),
    ],
    prerequisites: [
      ...new Set(actions.flatMap((a) => [...a.conditions, ...a.blockers.map((b) => b.recovery)])),
    ],
  };
}
export function canProposeEvent(view: Workflow | undefined, event: string): boolean {
  return view?.actions.some((a) => a.event === event && a.availability !== "blocked") ?? false;
}
export function canProposeAction(view: Workflow | undefined, operation: OperationName): boolean {
  return (
    view?.actions.some((a) => a.operation === operation && a.availability !== "blocked") ?? false
  );
}

/** Carries the same blockers returned by introspection across the server error boundary. */
export class WorkflowViolation extends Error {
  readonly blockers: Blocker[];
  constructor(blockers: Blocker[]) {
    super(blockers[0]?.message ?? "Workflow action is blocked");
    this.name = "WorkflowViolation";
    this.blockers = blockers;
  }
}
export function assertWorkflow(blockers: Blocker[]): void {
  if (blockers.length) throw new WorkflowViolation(blockers);
}
