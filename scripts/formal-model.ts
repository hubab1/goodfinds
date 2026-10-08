import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { z } from "zod";

export const formalDirectory = resolve(import.meta.dir, "../formal");
const repositoryDirectory = resolve(formalDirectory, "..");
const localElan = resolve(repositoryDirectory, ".local/elan");

async function run(command: string[], input?: string): Promise<string> {
  const lake = command[0];
  const local = lake === resolve(localElan, "bin/lake");
  const child = Bun.spawn(command, {
    cwd: formalDirectory,
    env: {
      ...process.env,
      ...(local ? { ELAN_HOME: localElan } : {}),
      // Each replay imports its own environment; bound checker memory on local/CI hosts.
      ...(command.includes("leanchecker")
        ? { LEAN_NUM_THREADS: process.env["LEAN_NUM_THREADS"] ?? "1" }
        : {}),
    },
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`Formal check failed (${command.join(" ")}):\n${stdout}${stderr}`);
  return stdout;
}

function lakeCommand(): string {
  const localLake = resolve(localElan, "bin/lake");
  const lake = Bun.which("lake") ?? (existsSync(localLake) ? localLake : null);
  if (!lake)
    throw new Error("Lean is required. Install elan as described in formal/README.md, then rerun.");
  return lake;
}

let build: Promise<string> | undefined;
export function buildFormalModel(): Promise<string> {
  build ??= (async () => {
    const lake = lakeCommand();
    const output = await run([lake, "--wfail", "build"]);
    if (output.trim()) process.stdout.write(`${output.trim()}\n`);
    await run([lake, "env", "leanchecker", "Goodfinds"]);
    return resolve(formalDirectory, ".lake/build/bin/seller_action_oracle");
  })();
  return build;
}

export async function evaluateSellerCases<S extends z.ZodType>(cases: unknown[], schema: S) {
  const oracle = await buildFormalModel();
  return schema.parse(JSON.parse(await run([oracle], JSON.stringify(cases))));
}

export async function auditFormalProbe(source: string): Promise<void> {
  await buildFormalModel();
  const directory = await mkdtemp(resolve(formalDirectory, ".lake/audit-probe-"));
  try {
    const file = resolve(directory, "Probe.lean");
    await writeFile(file, source);
    await run([lakeCommand(), "env", "lean", file]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
