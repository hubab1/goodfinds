import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const source = resolve(root, "apps/server/src");
const violations: string[] = [];
const domains = new Set([
  "workspace",
  "searches",
  "listings",
  "sellers",
  "connections",
  "configuration",
]);

// The production backend must be native.
for (const file of readdirSync(source, { recursive: true, encoding: "utf8" })) {
  if (file.endsWith(".ts")) violations.push(`Production server contains TypeScript: ${file}`);
  if (!file.endsWith(".rs")) continue;
  const text = readFileSync(resolve(source, file), "utf8").split(/#\[cfg\(test\)\]/u)[0] ?? "";
  if (/Command::new\(\s*"(?:bun|node|nodejs)"/u.test(text))
    violations.push(`${file} launches an external JavaScript runtime`);
  if (domains.has(file.replace(/\.rs$/u, ""))) {
    // Keep network futures outside synchronous SQLite command/receipt transactions.
    if (/\basync\s+fn\b|\.await\b|tokio::spawn\b|reqwest::/u.test(text))
      violations.push(`${file} performs asynchronous work inside the workspace domain`);
    if (/\bConnection::open\b/u.test(text))
      violations.push(`${file} opens a second database instead of using its Workspace`);
  }
}
const cargo = readFileSync(resolve(root, "apps/server/Cargo.toml"), "utf8");
if (!/\brusqlite\s*=\s*\{[^}]*"bundled"/u.test(cargo))
  violations.push("The native server must compile bundled SQLite");
for (const folder of ["apps/ui/src", "apps/ui/vite.preview.ts"]) {
  const files = folder.endsWith(".ts")
    ? [folder]
    : readdirSync(resolve(root, folder), { recursive: true, encoding: "utf8" })
        .filter((file) => /\.tsx?$/u.test(file))
        .map((file) => `${folder}/${file}`);
  for (const file of files)
    if (/@goodfinds\/server/u.test(readFileSync(resolve(root, file), "utf8")))
      violations.push(`${file} depends on a server implementation`);
}

if (violations.length) throw new Error(`Server architecture violations:\n${violations.join("\n")}`);
process.stdout.write("Native workspace commands stay synchronous.\n");
