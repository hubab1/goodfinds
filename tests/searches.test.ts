import { seedWorkspace } from "./helpers/workspace.ts";
import { revisionFor } from "./helpers/revisions.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createGoodfindsServer } from "@goodfinds/reference-server/mcp";
import {
  CUSTOM,
  NO_PREFERENCE,
  nativeAnswer,
  nativeQuestion,
} from "./reference-server/src/searches/interview.ts";
import {
  SEARCH_TEMPLATES,
  activeAnswers,
  draftInputSchema,
  searchDefinitionSchema,
  searchInputSchema,
  validateAnswers,
} from "@goodfinds/contracts/search-definition";
import { stateFromToolResult } from "@goodfinds/contracts/state";
import { interviewRequest, sendUserRequest } from "../apps/ui/src/lib/search.ts";

const rental = SEARCH_TEMPLATES.find((item) => item.category === "rental");
assert.ok(rental);
const rentalDefinition = rental;
const laptop = SEARCH_TEMPLATES.find((item) => item.category === "macbook_pro");
assert.ok(laptop);
const laptopDefinition = laptop;
const interviewResult = z.object({ interview: z.object({ status: z.string() }) });

void test("definitions validate their contract and conditional answers without laptop assumptions", () => {
  assert.equal(
    searchInputSchema.safeParse({
      name: "A home",
      product: "rental",
      definition: rentalDefinition,
      values: {
        area: "Birmingham",
        accommodation: "whole_property",
        min_bedrooms: 2,
        max_price_minor: 140000,
      },
    }).success,
    true,
  );
  assert.equal(
    draftInputSchema.safeParse({ name: "A home", definition: rentalDefinition, values: {} })
      .success,
    true,
  );
  assert.match(
    validateAnswers(rentalDefinition, { area: "Birmingham", accommodation: "whole_property" }).join(
      " ",
    ),
    /rent.*required/i,
  );
  assert.deepEqual(
    activeAnswers(rentalDefinition, {
      accommodation: "private_room",
      min_bedrooms: 4,
    }),
    { accommodation: "private_room" },
  );
  assert.equal(
    searchDefinitionSchema.safeParse({
      ...rentalDefinition,
      fields: [rentalDefinition.fields[0], rentalDefinition.fields[0]],
    }).success,
    false,
  );
  assert.equal(
    searchDefinitionSchema.safeParse({
      ...rentalDefinition,
      fields: [{ id: "x", label: "X", type: "text", match: { attribute: "x", operator: "gte" } }],
    }).success,
    false,
  );
  assert.equal(
    searchDefinitionSchema.safeParse({
      ...rentalDefinition,
      fields: [{ id: "constructor", label: "X", type: "text" }],
    }).success,
    false,
  );
  assert.equal(
    draftInputSchema.safeParse({
      name: "A home",
      definition: rentalDefinition,
      values: { unexpected: 1 },
    }).success,
    false,
  );
});

void test("nested conditions remove every hidden descendant and custom numeric choices remain editable", () => {
  const definition = searchDefinitionSchema.parse({
    ...rentalDefinition,
    fields: [
      {
        id: "arrangement",
        label: "Arrangement",
        type: "single_choice",
        options: [
          { value: "whole", label: "Whole" },
          { value: "room", label: "Room" },
        ],
      },
      {
        id: "bedrooms",
        label: "Bedrooms",
        type: "integer",
        visible_when: { field: "arrangement", one_of: ["whole"] },
      },
      {
        id: "parking",
        label: "Parking",
        type: "boolean",
        visible_when: { field: "bedrooms", one_of: [2] },
      },
    ],
  });
  assert.deepEqual(activeAnswers(definition, { arrangement: "room", bedrooms: 2, parking: true }), {
    arrangement: "room",
  });
  const memory = laptopDefinition.fields.find((field) => field.id === "min_ram_gb");
  assert.ok(memory);
  assert.equal(validateAnswers(laptopDefinition, { min_ram_gb: 36 }, true).length, 0);
  const request = nativeQuestion(memory);
  const property = z
    .object({ oneOf: z.array(z.object({ const: z.string(), title: z.string() })) })
    .parse(request.requestedSchema.properties[memory.id]);
  assert.ok(property.oneOf.some((option) => option.const === CUSTOM));
  assert.equal(nativeAnswer(memory, { min_ram_gb: "32" }), 32);
});

void test("native forms preserve false, no preference, ranges and displayed currency units", () => {
  const pets = { id: "pets", label: "Pets allowed", type: "boolean", required: false } as const;
  const rent = rentalDefinition.fields.find((field) => field.id === "max_price_minor");
  assert.ok(rent);
  assert.equal(nativeAnswer(pets, { pets: "false" }), false);
  assert.equal(nativeAnswer(pets, { pets: NO_PREFERENCE }), null);
  assert.equal(nativeAnswer(rent, { max_price_minor: 1234.56 }), 123456);
  const range = { id: "space", label: "Space", type: "range", required: false } as const;
  assert.deepEqual(nativeAnswer(range, { min: 10, max: 20 }), { min: 10, max: 20 });
  assert.equal(nativeAnswer(range, {}), null);
});

void test("native interview resumes a durable draft, handles cancellation and skips inapplicable questions", async (t) => {
  const data = await mkdtemp(resolve(tmpdir(), "goodfinds-interview-"));
  const { server } = createGoodfindsServer(seedWorkspace(data));
  const client = new Client(
    { name: "Question test", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } } },
  );
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(data, { recursive: true, force: true });
  });
  let cancel = true;
  let questionCount = 0;
  client.setRequestHandler(ElicitRequestSchema, (request) => {
    questionCount++;
    assert.equal(request.params.mode, "form");
    if (cancel) return { action: "cancel" };
    assert.ok("requestedSchema" in request.params);
    assert.deepEqual(Object.keys(request.params.requestedSchema.properties), ["accommodation"]);
    return { action: "accept", content: { accommodation: JSON.stringify("private_room") } };
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const before = stateFromToolResult(
    await client.callTool({ name: "get_goodfinds_workspace", arguments: {} }),
  );
  const created = stateFromToolResult(
    await client.callTool({
      name: "save_goodfinds_search_draft",
      arguments: {
        expected_entity_revision: revisionFor(before, "save_goodfinds_search_draft", { draft: {} }),
        draft: {
          name: "Room search",
          definition: rentalDefinition,
          values: {
            area: "Birmingham",
            property_type: null,
            floor: null,
            max_price_minor: 70000,
          },
        },
      },
    }),
  );
  const draft = created.drafts[0];
  assert.ok(draft);
  const cancelled = await client.callTool({
    name: "ask_goodfinds_search_question",
    arguments: { draft_id: draft.id },
  });
  assert.equal(interviewResult.parse(cancelled.structuredContent).interview.status, "cancelled");
  assert.equal(stateFromToolResult(cancelled).revision, created.revision);
  cancel = false;
  const answered = await client.callTool({
    name: "ask_goodfinds_search_question",
    arguments: { draft_id: draft.id },
  });
  assert.equal(interviewResult.parse(answered.structuredContent).interview.status, "ready");
  const completed = stateFromToolResult(answered);
  const readyDraft = completed.drafts[0];
  assert.ok(readyDraft);
  assert.equal(readyDraft.values["accommodation"], "private_room");
  assert.equal(readyDraft.values["min_bedrooms"], undefined);
  await client.callTool({
    name: "ask_goodfinds_search_question",
    arguments: { draft_id: draft.id },
  });
  assert.equal(questionCount, 2);
  const saved = stateFromToolResult(
    await client.callTool({
      name: "save_goodfinds_search",
      arguments: {
        expected_entity_revision: revisionFor(completed, "save_goodfinds_search", {
          draft_id: draft.id,
          search: {},
        }),
        draft_id: draft.id,
        expected_draft_revision: completed.revisions.drafts[draft.id],
        search: {
          name: readyDraft.name,
          product: "rental",
          definition: readyDraft.definition,
          values: readyDraft.values,
        },
      },
    }),
  );
  assert.equal(saved.drafts.length, 0);
  assert.deepEqual(saved.searches.at(-1)?.definition, rentalDefinition);
  assert.equal(saved.searches.at(-1)?.product, "rental");
});

void test("hosts without native questions return a resumable draft instead of inventing answers", async (t) => {
  const data = await mkdtemp(resolve(tmpdir(), "goodfinds-no-questions-"));
  const { calls } = createGoodfindsServer(seedWorkspace(data));
  t.after(() => rm(data, { recursive: true, force: true }));
  const read = calls.get("get_goodfinds_workspace");
  const prepare = calls.get("save_goodfinds_search_draft");
  const interview = calls.get("ask_goodfinds_search_question");
  assert.ok(read && prepare && interview);
  const before = stateFromToolResult(await read({}));
  const created = stateFromToolResult(
    await prepare({
      expected_entity_revision: before.revisions.absent,
      draft: { name: "A home", definition: rentalDefinition, values: {} },
    }),
  );
  const result = await interview({ draft_id: created.drafts[0]?.id });
  assert.equal(interviewResult.parse(result.structuredContent).interview.status, "unsupported");
  assert.equal(stateFromToolResult(result).revision, created.revision);
  assert.deepEqual(stateFromToolResult(result).drafts[0]?.values, {});
});

void test("interview requests require an automatic host connection without a copy fallback", async () => {
  const request = interviewRequest("A house to rent");
  assert.match(request, /A house to rent/);
  assert.match(request, /ask_goodfinds_search_question/);
  await assert.rejects(
    sendUserRequest({ getHostCapabilities: () => ({}), sendMessage: async () => ({}) }, request),
    /Automatic actions aren't available/,
  );
  await assert.rejects(
    sendUserRequest(
      {
        getHostCapabilities: () => ({ message: { text: {} } }),
        sendMessage: async () => ({ isError: true }),
      },
      request,
    ),
    /could not accept/,
  );
});
