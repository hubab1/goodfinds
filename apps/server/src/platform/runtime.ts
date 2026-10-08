import { homedir } from "node:os";
import { resolve } from "node:path";

// Compiled resources live inside Bun's virtual filesystem; source runs use the repository.
const root = Bun.isStandaloneExecutable ? import.meta.dir : resolve(import.meta.dir, "../../../..");
export const WORKSPACE_DIRECTORY =
  process.env["GOODFINDS_WORKSPACE_DIR"] || resolve(homedir(), ".local/share/goodfinds");
export const PANEL_HTML_PATH = resolve(
  root,
  Bun.isStandaloneExecutable ? "web/panel.html" : "dist/build/web/panel.html",
);
export const SEARCH_COVERS_DIRECTORY = resolve(
  root,
  Bun.isStandaloneExecutable ? "search-covers" : "assets/search-covers",
);
export const SERVER_ARGUMENTS = Bun.isStandaloneExecutable
  ? []
  : [resolve(root, "apps/server/src/main.ts")];
