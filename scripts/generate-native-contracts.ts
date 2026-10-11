import { z } from "zod";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { nativeToolCatalog } from "./native-tool-catalog.ts";
import { operations } from "@goodfinds/contracts/operations";
import { executionPolicy } from "@goodfinds/contracts/worker-execution";
import { GOODFINDS_VERSION, GOODFINDS_WORKFLOW_VERSION } from "@goodfinds/contracts/version";
import { SEARCH_TEMPLATES } from "@goodfinds/contracts/search-definition";
import { bundledSearchCovers } from "@goodfinds/contracts/search-cover-presets";
import example from "../skills/marketplace-shopping/assets/example-workspace.json";
import demo from "../skills/marketplace-shopping/assets/demo-listings.json";

// Defaults are evaluated when schema modules load, so regenerate in a UTC process.
if (process.env["TZ"] !== "UTC") {
  const child = Bun.spawn([process.execPath, import.meta.path, ...process.argv.slice(2)], {
    env: { ...process.env, TZ: "UTC" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await child.exited);
}

const checkOnly = process.argv.includes("--check");
const root = resolve(import.meta.dir, "..");
const schemas: Record<string, unknown> = {};
const data: Record<string, unknown> = {};
function schema(value: z.ZodType) {
  return z.toJSONSchema(value, {
    io: "input",
    unrepresentable: "any",
    override: ({ zodSchema, jsonSchema }) => {
      const def = zodSchema["_zod"].def;
      if (def.type === "object") {
        const catchall = "catchall" in def ? def.catchall : undefined;
        jsonSchema["x-unknown-keys"] =
          catchall instanceof z.ZodNever ? "strict" : catchall ? "passthrough" : "strip";
      }
      if (def.type === "string" && "checks" in def && Array.isArray(def.checks)) {
        for (const check of def.checks) {
          const transform = check["_zod"].def;
          if ("tx" in transform && String(transform.tx).includes(".trim()"))
            jsonSchema["x-trim"] = true;
        }
      }
    },
  });
}
const modules = (await readdir(resolve(root, "packages/contracts/src")))
  .filter((name) => name.endsWith(".ts"))
  .toSorted()
  .map((name) => resolve(root, "packages/contracts/src", name));
const imported: unknown[] = await Promise.all(modules.map((path) => import(path)));
for (const module of imported) {
  const exports = z.record(z.string(), z.unknown()).parse(module);
  for (const [name, value] of Object.entries(exports)) {
    if (value instanceof z.ZodType) schemas[name] = schema(value);
    else if (name === "searchCommands" || name === "sellerCommands") {
      for (const [command, input] of Object.entries(z.record(z.string(), z.unknown()).parse(value)))
        if (input instanceof z.ZodType) schemas[`${name}.${command}`] = schema(input);
    } else if (
      [
        "searchEvents",
        "searchGuards",
        "searchStates",
        "sellerEvents",
        "sellerGuards",
        "sellerStates",
        "MARKETPLACES",
        "REGIONAL_MARKETS",
        "LISTING_PATH_PATTERNS",
      ].includes(name)
    )
      data[name] = value;
  }
}
const operationData: Record<string, unknown> = {};
for (const [name, operation] of Object.entries(operations)) {
  schemas[`operations.${name}.input`] = schema(operation.input);
  schemas[`operations.${name}.output`] = schema(operation.output);
  operationData[name] = {
    kind: operation.kind,
    names: operation.names,
    annotations: operation.annotations,
  };
}
data["executionPolicies"] = {
  chat: executionPolicy("chat"),
  collection: executionPolicy("collection"),
  browser_collection: executionPolicy("browser_collection"),
};
data["templates"] = SEARCH_TEMPLATES;
data["workflowContract"] = {
  workflow_version: GOODFINDS_WORKFLOW_VERSION,
  plugin_version: GOODFINDS_VERSION,
  skill: "marketplace-shopping",
};
data["bundledSearchCovers"] = bundledSearchCovers;
data["example"] = example;
data["demo"] = demo;
const { tools, contracts: toolContracts, resources, instructions } = nativeToolCatalog();
const output = {
  schemas,
  data,
  operations: operationData,
  tools,
  tool_contracts: toolContracts,
  resources,
  instructions,
  schema_sql: await readFile(resolve(root, "apps/server/src/schema.sql"), "utf8"),
};
const path = resolve(root, "apps/server/data/contracts.json");
const generated = JSON.stringify(output) + "\n";
if (checkOnly) {
  if ((await readFile(path, "utf8")) !== generated)
    throw new Error("Native contracts are stale. Run bun run contracts:generate.");
} else {
  await mkdir(resolve(root, "apps/server/data"), { recursive: true });
  await writeFile(path, generated);
}
