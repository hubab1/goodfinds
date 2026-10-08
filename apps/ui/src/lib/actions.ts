import type { OperationInput, OperationName } from "@goodfinds/contracts/operations";
import type { operationNames } from "@goodfinds/contracts/tool-names";
import type { GoodfindsState } from "@goodfinds/contracts/state";

// The client resolves snapshot revisions to entity revisions before transport.
type PanelArguments<T> = Omit<T, "expected_entity_revision" | "expected_draft_revision"> & {
  snapshot_revision?: string;
  expected_entity_revision?: string;
  expected_draft_revision?: string;
};
type Inputs = {
  [K in OperationName as (typeof operationNames)[K][number]]: PanelArguments<OperationInput<K>>;
};
export type PanelTool = keyof Inputs;
export type PanelInput<K extends PanelTool> = Inputs[K];
export type Action = <K extends PanelTool>(
  name: K,
  args: PanelInput<K>,
  message?: string,
) => Promise<GoodfindsState | undefined>;
