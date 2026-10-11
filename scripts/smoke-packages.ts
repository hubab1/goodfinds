import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { GOODFINDS_VERSION } from "@goodfinds/contracts/version";
import { buildTarget } from "./build-target.ts";
import { pluginHosts } from "./plugin-formats.ts";

const root = resolve(import.meta.dir, "..");
const temporary = await mkdtemp(resolve(tmpdir(), "goodfinds extracted packages "));
async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`Package validation failed: ${command[0]}`);
}
try {
  const results = await Promise.allSettled(
    pluginHosts.map(async (host) => {
      const suffix = host === "claude-desktop" ? "mcpb" : "zip";
      const archive = resolve(
        root,
        "dist",
        `goodfinds-marketplace-${GOODFINDS_VERSION}-${host}-${buildTarget}.${suffix}`,
      );
      const destination = resolve(temporary, host);
      await mkdir(destination);
      await run(
        process.platform === "win32"
          ? [
              "powershell.exe",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${archive.replaceAll("'", "''")}', '${destination.replaceAll("'", "''")}')`,
            ]
          : ["unzip", "-q", archive, "-d", destination],
        root,
      );
      await run(
        [process.execPath, resolve(root, "scripts/smoke-plugin.ts"), destination, host],
        root,
      );
    }),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason as unknown),
      "Package smoke checks failed",
    );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
