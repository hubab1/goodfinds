import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { GOODFINDS_VERSION } from "@goodfinds/contracts/version";

export function panelResourceUri(inputs: ReadonlyArray<readonly [string, Uint8Array]>) {
  const hash = createHash("sha256");
  const normalized = inputs.map(([path, bytes]): readonly [string, Uint8Array] => [
    path.replaceAll("\\", "/"),
    bytes,
  ]);
  for (const [path, bytes] of normalized.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    hash.update(path).update("\0").update(bytes).update("\0");
  return `ui://goodfinds/shopping-panel-v${GOODFINDS_VERSION}-${hash.digest("hex").slice(0, 16)}.html`;
}

// Contracts are exported before native compilation. Fingerprint all frontend
// source inputs so the host cannot reuse HTML from an earlier local build.
export function panelResourceInputs(root = resolve(import.meta.dir, "..")) {
  const files = [
    "apps/ui/index.html",
    "apps/ui/vite.config.ts",
    "apps/ui/tsconfig.json",
    "apps/ui/package.json",
    "packages/contracts/package.json",
    "scripts/finalize-build.ts",
    "bun.lock",
    "package.json",
    "tsconfig.json",
  ];
  for (const directory of ["apps/ui/src", "packages/contracts/src", "packages/contracts/data"])
    for (const entry of readdirSync(resolve(root, directory), {
      recursive: true,
      withFileTypes: true,
    }))
      if (entry.isFile()) files.push(relative(root, resolve(entry.parentPath, entry.name)));
  return files.map((path): readonly [string, Uint8Array] => [
    path,
    readFileSync(resolve(root, path)),
  ]);
}
