#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const executable = resolve(
  import.meta.dir,
  "../../../dist/build/server",
  process.platform === "win32" ? "goodfinds.exe" : "goodfinds",
);
if (!existsSync(executable)) throw new Error("Build the native server first with bun run build.");
const child = Bun.spawn([executable, ...process.argv.slice(2)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exitCode = await child.exited;
