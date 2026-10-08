import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const source = resolve(root, "apps/server/src");
const reference = resolve(root, "tests/reference-server/src");
const violations: string[] = [];
const domains = ["workspace", "searches", "listings", "sellers", "connections", "configuration"];

// The production backend must be native and cannot call the reference implementation.
for (const file of readdirSync(source, { recursive: true, encoding: "utf8" })) {
  if (file.endsWith(".ts")) violations.push(`Production server contains TypeScript: ${file}`);
  if (!file.endsWith(".rs")) continue;
  const text = readFileSync(resolve(source, file), "utf8").split(/#\[cfg\(test\)\]/u)[0] ?? "";
  if (/reference-server|@goodfinds\/reference-server/u.test(text))
    violations.push(`${file} depends on the development reference server`);
  if (/Command::new\(\s*"(?:bun|node|nodejs)"/u.test(text))
    violations.push(`${file} launches an external JavaScript runtime`);
  if (domains.includes(file.replace(/\.rs$/u, ""))) {
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
    if (/reference-server|@goodfinds\/server/u.test(readFileSync(resolve(root, file), "utf8")))
      violations.push(`${file} depends on the development reference server`);
}

// The retained oracle keeps its own boundary so reference tests remain meaningful.
for (const domain of domains.filter((name) => name !== "configuration")) {
  for (const file of readdirSync(resolve(reference, domain), {
    recursive: true,
    encoding: "utf8",
  })) {
    if (!file.endsWith(".ts")) continue;
    const path = resolve(reference, domain, file);
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/g)) {
      const imported = match[2];
      if (!imported) continue;
      const target = imported.startsWith(".")
        ? relative(reference, resolve(dirname(path), imported))
        : imported;
      if (
        /^(?:platform\/|entrypoints\/|bun:sqlite$|node:(?:fs|child_process)(?:\/|$)|@effect\/platform)/u.test(
          target,
        )
      )
        violations.push(`Reference ${relative(reference, path)} imports ${imported}`);
    }
    if (/\bprocess\.env\b/u.test(text))
      violations.push(`Reference ${relative(reference, path)} reads process.env`);
  }
}
if (violations.length) throw new Error(`Server architecture violations:\n${violations.join("\n")}`);
process.stdout.write(
  "Native runtime is independent of the reference server; workspace commands stay synchronous.\n",
);
