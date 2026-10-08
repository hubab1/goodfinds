import { z } from "zod";
import { readdir, readFile, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGoodfindsServer } from "../tests/reference-server/src/entrypoints/mcp.ts";
import { operations } from "@goodfinds/contracts/operations";
import { executionPolicy } from "@goodfinds/contracts/worker-execution";
import { WORKSPACE_SCHEMA_SQL } from "../tests/reference-server/src/platform/database-schema.ts";
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
const modules = [
  ...(await readdir(resolve(root, "packages/contracts/src")))
    .filter((name) => name.endsWith(".ts"))
    .toSorted()
    .map((name) => resolve(root, "packages/contracts/src", name)),
  resolve(root, "tests/reference-server/src/workspace/model.ts"),
  resolve(root, "tests/reference-server/src/connections/ebay.ts"),
];
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
};
data["templates"] = SEARCH_TEMPLATES;
data["bundledSearchCovers"] = bundledSearchCovers;
data["example"] = example;
data["demo"] = demo;
const workspace = await mkdtemp(resolve(tmpdir(), "goodfinds-contracts-"));
const { server } = createGoodfindsServer(workspace);
const client = new Client({ name: "Goodfinds contract exporter", version: "0.1.0" });
try {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const tools = (await client.listTools()).tools;
  const resources = (await client.listResources()).resources;
  const output = {
    schemas,
    data,
    operations: operationData,
    tools,
    resources,
    instructions: client.getInstructions(),
    schema_sql: WORKSPACE_SCHEMA_SQL,
  };
  const path = resolve(root, "apps/server/data/contracts.json");
  const generated = JSON.stringify(output) + "\n";
  if (checkOnly) {
    const saved = await readFile(path, "utf8");
    if (saved !== generated)
      throw new Error("Native contracts are stale. Run bun run contracts:generate.");
  } else {
    await mkdir(resolve(root, "apps/server/data"), { recursive: true });
    await writeFile(path, generated);
  }
  process.stdout.write(
    `${checkOnly ? "Verified" : "Generated"} ${Object.keys(schemas).length} schemas and ${tools.length} native tool contracts.\n`,
  );
} finally {
  await client.close();
  await server.close();
  await rm(workspace, { recursive: true, force: true });
}
