import type { WorkspaceMode } from "@goodfinds/contracts/state";
import exampleConfig from "../../skills/marketplace-shopping/assets/example-workspace.json" with { type: "json" };
import { nativeCall } from "./native-driver.ts";

// Tests opt into fictional searches; production workspaces start empty.
export function seedWorkspace(base: string, mode: WorkspaceMode = "live"): string {
  if (mode === "live") nativeCall({ op: "seed", root: base, args: exampleConfig });
  return base;
}
