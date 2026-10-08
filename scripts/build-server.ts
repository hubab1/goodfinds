import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildTarget } from "./build-target.ts";

const root = resolve(import.meta.dir, "..");
const output = resolve(root, "dist/build");
const server = resolve(output, "server");
mkdirSync(server, { recursive: true });
// Resolve build inputs from the project root; each embedded directory keeps its basename.
process.chdir(root);
rmSync(resolve(server, "build.json"), { force: true });

export const result = await Bun.build({
  entrypoints: [resolve(root, "apps/server/src/main.ts")],
  target: "bun",
  format: "esm",
  minify: true,
  compile: {
    target: buildTarget,
    outfile: resolve(server, "goodfinds"),
    assets: ["./dist/build/web", "./assets/search-covers"],
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
});
if (!result.success)
  throw new AggregateError(result.logs, "Could not compile the Goodfinds server");
rmSync(resolve(server, "goodfinds.mjs"), { force: true });
writeFileSync(resolve(server, "build.json"), `${JSON.stringify({ target: buildTarget })}\n`);
