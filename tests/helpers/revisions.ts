import type { Revisions } from "@goodfinds/contracts/revisions";
import { entityRevision, entityTarget } from "@goodfinds/contracts/revisions";
import { operationForTool } from "@goodfinds/contracts/tool-names";
export function revisionFor(
  state: { revisions: Revisions },
  action: string,
  args: Record<string, unknown> = {},
) {
  const operation = operationForTool(action) ?? action;
  const target = entityTarget(operation, args);
  return target ? entityRevision(state.revisions, target) : state.revisions.settings;
}
