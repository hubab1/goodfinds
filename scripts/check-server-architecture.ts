import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const source = resolve(import.meta.dir, "../apps/server/src");
const domains = ["workspace", "searches", "listings", "sellers", "connections"];
const violations: string[] = [];
for (const domain of domains) {
  const folder = resolve(source, domain);
  for (const file of readdirSync(folder, { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".ts")) continue;
    const path = resolve(folder, file);
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/g)) {
      const reference = match[2];
      if (!reference) continue;
      const target = reference.startsWith(".")
        ? relative(source, resolve(dirname(path), reference))
        : reference;
      if (
        /^(?:platform\/|entrypoints\/|bun:sqlite$|node:(?:fs|child_process)(?:\/|$)|@effect\/platform)/.test(
          target,
        )
      ) {
        violations.push(`${relative(source, path)} imports ${reference}`);
      }
    }
    if (/\bprocess\.env\b/.test(text))
      violations.push(`${relative(source, path)} reads process.env`);
  }
}
if (violations.length)
  throw new Error(
    `Domain modules must receive platform dependencies through ports:\n${violations.join("\n")}`,
  );
process.stdout.write("Server domain dependencies are isolated from platform adapters.\n");
