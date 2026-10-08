import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const source = resolve(import.meta.dir, "../apps/ui/src");
const ui = resolve(source, "components/ui");
const utilities = resolve(source, "lib/utils");
const violations: string[] = [];

for (const file of readdirSync(ui, { recursive: true, encoding: "utf8" })) {
  if (!/\.tsx?$/.test(file)) continue;
  const path = resolve(ui, file);
  const text = readFileSync(path, "utf8");
  for (const match of text.matchAll(/(?:from\s+|import\s*(?:\(\s*)?)["']([^"']+)["']/g)) {
    const reference = match[1];
    if (!reference) continue;
    const target = reference.startsWith("@/")
      ? resolve(source, reference.slice(2))
      : reference.startsWith(".")
        ? resolve(dirname(path), reference)
        : undefined;
    if (
      reference.startsWith("@goodfinds/") ||
      (target && !target.startsWith(ui + sep) && target.replace(/\.tsx?$/, "") !== utilities)
    ) {
      violations.push(`${relative(source, path)} imports ${reference}`);
    }
  }
}

if (violations.length) {
  throw new Error(
    `Shared UI must receive feature data and actions through props:\n${violations.join("\n")}`,
  );
}
process.stdout.write(
  "Shared panel UI is independent of features, domain contracts and transport.\n",
);
