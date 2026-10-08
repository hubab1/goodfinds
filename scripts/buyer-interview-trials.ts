import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createGoodfindsServer } from "@goodfinds/server/mcp";
import { NO_PREFERENCE } from "../apps/server/src/searches/interview.ts";
import { answersSchema, searchDefinitionSchema } from "@goodfinds/contracts/search-definition";
import { stateFromToolResult } from "@goodfinds/contracts/state";

const scenarioSchema = z.object({
  id: z.string(),
  brief: z.string(),
  definition: searchDefinitionSchema,
  values: answersSchema,
  answers: answersSchema,
  expected_setup_questions: z.array(z.string()),
});
export type BuyerScenario = z.infer<typeof scenarioSchema>;

export async function buyerScenarios(): Promise<BuyerScenario[]> {
  return z
    .array(scenarioSchema)
    .parse(
      JSON.parse(
        await readFile(
          new URL("../tests/fixtures/buyer-interview-cases.json", import.meta.url),
          "utf8",
        ),
      ),
    );
}

// These agent-authored briefs exercise the real MCP interview protocol with a
// simulated buyer. They are not an automated evaluation of model generation.
export async function runBuyerTrial(
  scenario: BuyerScenario,
  stage: "setup" | "refinement" = "setup",
  refinementFields?: string[],
) {
  const data = await mkdtemp(resolve(tmpdir(), "goodfinds-buyer-trial-"));
  const { server } = createGoodfindsServer(data);
  const client = new Client(
    { name: "Simulated buyer", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } } },
  );
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const definition = scenario.definition;
  const asked: Array<{ id: string; label: string; choices: string[] }> = [];
  client.setRequestHandler(ElicitRequestSchema, (request) => {
    if (!("requestedSchema" in request.params)) throw new Error("Expected a native form");
    const id = Object.keys(request.params.requestedSchema.properties)[0];
    const field = definition.fields.find((item) => item.id === id);
    if (!field) throw new Error("Unexpected question");
    asked.push({
      id: field.id,
      label: field.label,
      choices: field.options?.map((option) => option.label) ?? [],
    });
    const value = scenario.answers[field.id] ?? null;
    if (value === null) {
      if (field.required) throw new Error(`The simulated buyer has no answer for ${field.id}`);
      return {
        action: "accept",
        content: field.options || field.type === "boolean" ? { [field.id]: NO_PREFERENCE } : {},
      };
    }
    const answer =
      field.type === "multiple_choice"
        ? value
        : field.options || field.type === "boolean"
          ? JSON.stringify(value)
          : typeof value === "number"
            ? value / (field.display_divisor ?? 1)
            : value;
    return { action: "accept", content: { [field.id]: answer } };
  });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    let state = stateFromToolResult(
      await client.callTool({ name: "get_goodfinds_workspace", arguments: {} }),
    );
    state = stateFromToolResult(
      await client.callTool({
        name: "save_goodfinds_search_draft",
        arguments: {
          expected_entity_revision: state.revisions.absent,
          draft: { name: definition.title, definition, values: scenario.values },
        },
      }),
    );
    const draft = state.drafts[0];
    if (!draft) throw new Error("Missing test draft");
    let ready = false;
    for (let count = 0; count < 31; count++) {
      // Each answer changes the draft used to select the next applicable question.
      // eslint-disable-next-line no-await-in-loop
      const result = await client.callTool({
        name: "ask_goodfinds_search_question",
        arguments: {
          draft_id: draft.id,
          stage,
          ...(refinementFields ? { refinement_fields: refinementFields } : {}),
        },
      });
      state = stateFromToolResult(result);
      if (
        z.object({ interview: z.object({ status: z.string() }) }).parse(result.structuredContent)
          .interview.status === "ready"
      ) {
        ready = true;
        break;
      }
    }
    if (!ready) throw new Error("Interview failed to reach review");
    const completed = state.drafts[0];
    if (!completed) throw new Error("Missing completed draft");
    state = stateFromToolResult(
      await client.callTool({
        name: "save_goodfinds_search",
        arguments: {
          expected_entity_revision: state.revisions.absent,
          draft_id: draft.id,
          expected_draft_revision: state.revisions.drafts[draft.id] ?? state.revisions.absent,
          search: {
            name: definition.title,
            product: definition.category,
            definition,
            values: completed.values,
          },
        },
      }),
    );
    return {
      id: scenario.id,
      brief: scenario.brief,
      questions: asked,
      count: asked.length,
      saved: state.searches.at(-1),
    };
  } finally {
    await client.close();
    await server.close();
    await rm(data, { recursive: true, force: true });
  }
}
