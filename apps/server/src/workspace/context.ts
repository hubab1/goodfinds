import { randomUUID } from "node:crypto";
import type { WorkspaceMode } from "@goodfinds/contracts/state";

export const ACCESS_CONTEXT = randomUUID();

export interface WorkspaceContext {
  readonly base: string;
  readonly folder: string;
  readonly databasePath: string;
  readonly mode: WorkspaceMode;
  readonly automationsDirectory: string | null;
}
