import { nativeBinary } from "./helpers/native-driver.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { operations, errorSchema } from "@goodfinds/contracts/operations";
import { searchDefinitionSchema, searchInputSchema } from "@goodfinds/contracts/search-definition";
import { z } from "zod";

// Some MCP clients display text content without structuredContent. Exercise that boundary.
const textResult = (result: unknown): unknown => {
  const { content } = z
    .object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })) })
    .parse(result);
  return JSON.parse(content.map((item) => item.text).join("\n")) as unknown;
};

void test("a text-only MCP client can recover scoped revisions and promote an unbounded buying brief", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "goodfinds-setup-recovery-"));
  const client = new Client({ name: "Text-only setup regression", version: "1" });
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });
  await client.connect(
    new StdioClientTransport({
      command: nativeBinary,
      env: { PATH: "", GOODFINDS_WORKSPACE_DIR: root },
    }),
  );
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  const read = async () =>
    operations.get_search_context.output.parse(
      textResult(await call("get_goodfinds_search_context")),
    );
  const initial = await read();
  const catalog = z
    .object({ templates: z.array(searchDefinitionSchema) })
    .parse(textResult(await call("list_goodfinds_search_templates")));
  const template = catalog.templates.find((item) => item.category === "macbook_pro");
  assert.ok(template);
  const definition = structuredClone(template);
  const budget = definition.fields.find((field) => field.id === "max_price_minor");
  assert.ok(budget);
  budget.required = false;
  const search = searchInputSchema.parse({
    name: "MacBook Pro",
    product: "macbook_pro",
    marketplaces: ["facebook_marketplace"],
    definition: {
      ...definition,
      version: definition.version + 1,
      fields: definition.fields,
    },
    values: {
      screen_inches: 14,
      item_state: "used",
      min_chip_generation: 3,
      min_ram_gb: 24,
      min_ssd_gb: 1000,
      max_price_minor: null,
      max_drive_minutes: 60,
      allowed_conditions: ["good", "excellent", "like_new"],
    },
  });
  const draft = {
    id: "draft-setup-recovery",
    name: search.name,
    definition: search.definition,
    values: search.values,
    marketplaces: search.marketplaces,
  };
  const wrong = await call("save_goodfinds_search_draft", {
    request_id: crypto.randomUUID(),
    draft,
    expected_entity_revision: initial.revision,
  });
  assert.equal(wrong.isError, true);
  const conflict = z.object({ error: errorSchema }).parse(textResult(wrong)).error;
  assert.equal(conflict.code, "revision_conflict");
  assert.equal(conflict.resource, `drafts:${draft.id}`);
  assert.equal(conflict.current_revision, initial.revisions.absent);
  const refreshed = await read();
  const saved = await call("save_goodfinds_search_draft", {
    request_id: crypto.randomUUID(),
    draft,
    expected_entity_revision: refreshed.revisions.absent,
  });
  assert.ok(!saved.isError);
  const draftState = operations.save_search_draft.output.parse(textResult(saved));
  const draftRevision = draftState.revisions.drafts[draft.id];
  assert.ok(draftRevision);
  const wrongPromotion = await call("save_goodfinds_search", {
    request_id: crypto.randomUUID(),
    search,
    draft_id: draft.id,
    expected_entity_revision: draftRevision,
    expected_draft_revision: draftState.revision,
  });
  assert.equal(wrongPromotion.isError, true);
  const promotionConflict = z
    .object({ error: errorSchema })
    .parse(textResult(wrongPromotion)).error;
  assert.equal(promotionConflict.resource, "searches");
  assert.equal(promotionConflict.current_revision, initial.revisions.absent);
  const wrongDraftToken = await call("save_goodfinds_search", {
    request_id: crypto.randomUUID(),
    search,
    draft_id: draft.id,
    expected_entity_revision: initial.revisions.absent,
    expected_draft_revision: draftState.revision,
  });
  assert.equal(wrongDraftToken.isError, true);
  const draftConflict = z.object({ error: errorSchema }).parse(textResult(wrongDraftToken)).error;
  assert.equal(draftConflict.resource, `drafts:${draft.id}`);
  assert.equal(draftConflict.current_revision, draftRevision);
  const malformed = await call("save_goodfinds_search", {
    request_id: crypto.randomUUID(),
    search: JSON.stringify(search),
    expected_entity_revision: initial.revisions.absent,
  });
  assert.equal(malformed.isError, true);
  assert.equal(
    z.object({ error: errorSchema }).parse(textResult(malformed)).error.code,
    "validation_error",
  );
  const current = await read();
  const promoted = await call("save_goodfinds_search", {
    request_id: crypto.randomUUID(),
    search,
    draft_id: draft.id,
    expected_entity_revision: current.revisions.absent,
    expected_draft_revision: current.revisions.drafts[draft.id],
  });
  assert.ok(!promoted.isError, JSON.stringify(promoted));
  const result = operations.save_search.output.parse(textResult(promoted));
  assert.equal(result.search?.values["max_price_minor"], null);
  assert.equal(result.search?.values["min_ssd_gb"], 1000);
  assert.equal(result.search?.values["screen_inches"], 14);
  assert.equal(result.search?.values["item_state"], "used");
  for (const attribute of ["screen_inches", "item_state"]) {
    assert.deepEqual(
      result.search?.definition.fields.find((field) => field.id === attribute)?.match,
      { attribute, operator: "eq", importance: "required" },
    );
  }
  const end = await read();
  assert.equal(end.searches.length, 1);
  assert.equal(end.drafts.length, 0);
  const direct = await call("save_goodfinds_search", {
    request_id: crypto.randomUUID(),
    search: { ...search, id: "direct-ready-brief" },
    expected_entity_revision: end.revisions.absent,
  });
  assert.ok(!direct.isError);
  assert.equal((await read()).drafts.length, 0);
});
