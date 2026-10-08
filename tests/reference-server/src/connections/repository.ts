import type { WorkspaceMode } from "@goodfinds/contracts/state";
import type { CheckRecord } from "./model.ts";

export interface ConnectionCheckTransaction {
  readonly save: (run: CheckRecord) => void;
  readonly active: () => CheckRecord[];
  readonly find: (context: string, id?: string) => CheckRecord | null;
  readonly findRequest: (requestId: string) => CheckRecord | null;
  readonly findActive: (context: string, scope: string) => CheckRecord | null;
}
export interface ConnectionCheckStorage {
  readonly exists: (mode: WorkspaceMode) => boolean;
  readonly transaction: <A>(
    mode: WorkspaceMode,
    operation: (transaction: ConnectionCheckTransaction) => A,
  ) => A;
}
