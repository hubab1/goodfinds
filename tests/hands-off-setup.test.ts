import { nativeBinary } from "./helpers/native-driver.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { operations, errorSchema } from "@goodfinds/contracts/operations";

const binary = nativeBinary;
const resultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()),
});
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), "goodfinds-hands-off-"));
  const client = new Client({ name: "Hands-off setup regression", version: "1" });
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });
  await client.connect(
    new StdioClientTransport({ command: binary, env: { PATH: "", GOODFINDS_WORKSPACE_DIR: root } }),
  );
  return async (name: string, args: Record<string, unknown> = {}) =>
    resultSchema.parse(await client.callTool({ name, arguments: args }));
}
const brief = (id: string) => ({
  id,
  name: "iPhone 18 Pro",
  product: "iphone",
  enabled: true,
  definition: {
    schema_version: 1,
    version: 1,
    category: "iphone",
    title: "iPhone 18 Pro",
    description: "Both budget and travel limits are required.",
    price: { currency: "GBP", period: "once" },
    comparison_attributes: ["model"],
    fields: [
      {
        id: "model",
        type: "text",
        label: "Model",
        required: true,
        match: { attribute: "model", operator: "eq", importance: "required" },
      },
      {
        id: "budget",
        type: "integer",
        label: "Budget",
        required: true,
        match: { attribute: "price_minor", operator: "lte", importance: "required" },
      },
      {
        id: "drive",
        type: "integer",
        label: "Maximum drive",
        required: true,
        match: { attribute: "drive_minutes", operator: "lte", importance: "required" },
      },
    ],
  },
  values: { model: "iPhone 18 Pro", budget: 95000, drive: 30 },
});
void test("missing mutation inputs are reported together with schema recovery", async (t) => {
  const call = await fixture(t);
  await Promise.all(
    [
      ["save_goodfinds_search_draft", "draft"],
      ["save_goodfinds_settings", "settings"],
    ].map(async ([tool, field]) => {
      assert.ok(tool && field);
      const result = await call(tool);
      const error = errorSchema.parse(result.structuredContent["error"]);
      assert.equal(result.isError, true);
      assert.match(error.message, /expected_entity_revision/);
      assert.match(error.message, new RegExp(`\\b${field}\\b`));
      assert.match(error.recovery, /schema/);
    }),
  );
});
void test("an explicitly supplied city stays confirmed when old coordinates are cleared", async (t) => {
  const call = await fixture(t);
  const initial = operations.get_settings.output.parse(
    (await call("get_goodfinds_settings")).structuredContent,
  );
  const located = await call("save_goodfinds_settings", {
    expected_entity_revision: initial["revisions"].settings,
    settings: {
      location: {
        source: "device",
        latitude: 53.48,
        longitude: -2.24,
        accuracy_m: 100,
        area: "Manchester",
        country: "GB",
        acquired_at: "2026-10-10T08:00:00Z",
        display: "town",
      },
    },
  });
  assert.ok(!located.isError, JSON.stringify(located));
  const oldLocation = operations.save_settings.output.parse(located.structuredContent);
  const result = await call("save_goodfinds_settings", {
    expected_entity_revision: oldLocation.revisions.settings,
    settings: { origin: "Birmingham, UK", location: null },
  });
  assert.ok(!result.isError);
  const current = operations.get_settings.output.parse(
    (await call("get_goodfinds_settings")).structuredContent,
  );
  assert.equal(current["settings"].origin, "Birmingham, UK");
  assert.equal(current["settings"].location, null);
  assert.equal(current["origin_confirmed"], true);
});
void test("ready briefs default to two-hour monitoring, preserve edits, and honor one-off setup", async (t) => {
  const call = await fixture(t);
  const initial = operations.get_settings.output.parse(
    (await call("get_goodfinds_settings")).structuredContent,
  );
  const first = await call("save_goodfinds_search", {
    expected_entity_revision: initial["revisions"].absent,
    search: brief("phone"),
  });
  assert.ok(!first.isError, JSON.stringify(first));
  const saved = operations.save_search.output.parse(first.structuredContent);
  assert.equal(saved.monitoring[0]?.preference, "recurring");
  assert.equal(saved.monitoring[0]?.interval_minutes, 120);
  assert.equal(saved.monitoring[0]?.next_action, "start");
  assert.equal(saved.monitoring[0]?.schedule, null);
  const stopped = operations.set_monitoring.output.parse(
    (
      await call("set_goodfinds_monitoring", {
        expected_entity_revision: saved["revisions"].monitoring["phone"],
        monitoring: { search_id: "phone", preference: "once" },
      })
    ).structuredContent,
  );
  const edited = operations.save_search.output.parse(
    (
      await call("save_goodfinds_search", {
        expected_entity_revision: stopped["revisions"].searches["phone"],
        search: brief("phone"),
      })
    ).structuredContent,
  );
  assert.equal(edited.monitoring[0]?.preference, "once");
  const once = await call("save_goodfinds_search", {
    expected_entity_revision: initial["revisions"].absent,
    search: brief("once"),
    initial_monitoring: { preference: "once" },
  });
  assert.ok(!once.isError, JSON.stringify(once));
  assert.equal(
    operations.save_search.output
      .parse(once.structuredContent)
      .monitoring.find((m) => m.search_id === "once")?.preference,
    "once",
  );
  const cadence = await call("save_goodfinds_settings", {
    expected_entity_revision: saved.revisions.settings,
    settings: { interval_minutes: 180 },
  });
  assert.ok(!cadence.isError, JSON.stringify(cadence));
  const custom = await call("save_goodfinds_search", {
    expected_entity_revision: initial.revisions.absent,
    search: brief("custom"),
  });
  assert.ok(!custom.isError, JSON.stringify(custom));
  assert.equal(
    operations.save_search.output
      .parse(custom.structuredContent)
      .monitoring.find((m) => m.search_id === "custom")?.interval_minutes,
    180,
  );
});
void test("setup context includes settings and matching templates without full saved definitions or workflows", async (t) => {
  const call = await fixture(t);
  const initial = operations.get_settings.output.parse(
    (await call("get_goodfinds_settings")).structuredContent,
  );
  await call("save_goodfinds_search", {
    expected_entity_revision: initial["revisions"].absent,
    search: brief("phone"),
  });
  const result = await call("get_goodfinds_setup_context", {
    category: "macbook_pro",
    preferences: { country: "GB" },
  });
  assert.ok(!result.isError, JSON.stringify(result));
  const setup = operations.get_setup_context.output.parse(result.structuredContent);
  assert.equal(setup["settings"].interval_minutes, 120);
  assert.equal(setup.search_index[0]?.id, "phone");
  assert.ok(setup.search_index[0] && !("definition" in setup.search_index[0]));
  assert.equal(setup["templates"].length, 1);
  assert.equal(setup.templates[0]?.category, "macbook_pro");
  assert.equal(result.structuredContent["search_run_workflows"], undefined);
});
void test("the packaged helper exposes the exact schema without mutation probes", async () => {
  const child = Bun.spawn([binary, "schema", "save_goodfinds_search"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, errors);
  const schema = z
    .object({ name: z.string(), inputSchema: z.object({ required: z.array(z.string()) }).loose() })
    .parse(JSON.parse(output) as unknown);
  assert.equal(schema.name, "save_goodfinds_search");
  assert.ok(schema.inputSchema.required.includes("search"));
});

void test("research permits absent empty lists and validation identifies nested fields", async (t) => {
  const call = await fixture(t);
  const setup = operations.get_setup_context.output.parse(
    (await call("get_goodfinds_setup_context")).structuredContent,
  );
  const search = {
    ...brief("research"),
    discovery: {
      scope: "exact",
      reference_model: "iPhone 18 Pro",
      research: {
        summary: "Fixture research",
        checked_at: "2026-10-10T08:00:00Z",
        sources: [{ url: "https://example.com/fixture", title: "Fixture source" }],
      },
    },
  };
  const result = await call("save_goodfinds_search", {
    search,
    expected_entity_revision: setup.revisions.absent,
  });
  assert.ok(!result.isError, JSON.stringify(result));
  const saved = operations.save_search.output.parse(result.structuredContent);
  assert.deepEqual(saved.search?.discovery?.research?.queries, []);
  assert.deepEqual(saved.search?.discovery?.research?.candidates, []);
  const invalid = await call("save_goodfinds_search", {
    search: {
      ...brief("invalid"),
      definition: { ...brief("invalid").definition, description: undefined },
    },
    expected_entity_revision: setup.revisions.absent,
  });
  assert.equal(invalid.isError, true);
  const error = errorSchema.parse(invalid.structuredContent["error"]);
  assert.match(error.message, /\/search\/definition.*description/);
  assert.ok(error.message.length < 1200);
});
