import { z } from "zod";
import metadata from "../packages/contracts/data/tool-metadata.json";
import { operations, wireSchema } from "@goodfinds/contracts/operations";
import { operationForTool } from "@goodfinds/contracts/tool-names";
import {
  connectionCheckTools,
  connectionCheckResultSchema,
} from "@goodfinds/contracts/connection-checks";
import { createToolCatalog, GOODFINDS_MCP_INSTRUCTIONS } from "@goodfinds/contracts/mcp-catalog";
import { searchCommands } from "@goodfinds/contracts/search-workflow";
import { searchDefinitionSchema } from "@goodfinds/contracts/search-definition";
import { searchCoverSchema } from "@goodfinds/contracts/search-cover";
import { searchCoverCategorySchema } from "@goodfinds/contracts/search-cover-presets";
import {
  locationPageResultSchema,
  marketplaceCapabilitiesInputSchema,
  marketplaceCapabilitiesResultSchema,
} from "@goodfinds/contracts/external-tools";
import { panelResourceInputs, panelResourceUri } from "./panel-resource.ts";

const mode = z.enum(["live", "sample"]).default("live");
const mediaId = z.string().regex(/^[a-f0-9]{64}$/);
const files = z
  .array(z.object({ path: z.string().min(1), label: z.string().max(200) }).strict())
  .min(1)
  .max(20);
const cached = z.object({
  media: z.array(
    z.object({ id: mediaId, mime_type: z.string(), size_bytes: z.number(), label: z.string() }),
  ),
});
const extra: Record<string, { input: z.ZodObject; output?: z.ZodObject }> = {
  get_goodfinds_tool_schema: {
    input: z.object({ name: z.string().min(1) }).strict(),
    output: z.object({
      name: z.string(),
      description: z.string(),
      inputSchema: z.record(z.string(), z.unknown()),
    }),
  },
  list_goodfinds_search_covers: {
    input: z.object({ category: searchCoverCategorySchema.optional() }).strict(),
    output: z.object({
      covers: z.array(
        z.object({
          category: searchCoverCategorySchema,
          preset: z.string(),
          label: z.string(),
          cover: searchCoverSchema,
        }),
      ),
    }),
  },
  list_goodfinds_search_templates: {
    input: z.object({}),
    output: z.object({ templates: z.array(searchDefinitionSchema) }),
  },
  ask_goodfinds_search_question: {
    input: z
      .object({
        mode,
        draft_id: z.string(),
        stage: z.enum(["setup", "refinement"]).default("setup"),
        refinement_fields: z.array(z.string()).min(1).max(10).optional(),
      })
      .strict(),
    output: z.object({
      state: operations.get_workspace.output.shape.state,
      interview: z
        .object({
          status: z.enum([
            "ready",
            "needs_guidance",
            "unsupported",
            "cancelled",
            "declined",
            "answered",
          ]),
          stage: z.enum(["setup", "refinement"]),
          draft_id: z.string(),
          remaining_refinements: z.array(z.object({ id: z.string(), label: z.string() })),
        })
        .loose(),
    }),
  },
  open_goodfinds_location_chooser: { input: z.object({ mode }), output: locationPageResultSchema },
  list_goodfinds_marketplace_capabilities: {
    input: marketplaceCapabilitiesInputSchema,
    output: marketplaceCapabilitiesResultSchema,
  },
  cache_goodfinds_images: { input: z.object({ files }).strict(), output: cached },
  cache_goodfinds_media: { input: z.object({ files }).strict(), output: cached },
  get_goodfinds_media_file: {
    input: z.object({ media_id: mediaId }).strict(),
    output: z.object({
      media_id: mediaId,
      path: z.string(),
      mime_type: z.string(),
      size_bytes: z.number(),
    }),
  },
  get_goodfinds_image: { input: z.object({ media_id: mediaId }).strict() },
  get_goodfinds_video: {
    input: z.object({ media_id: mediaId }).strict(),
    output: z.object({ mime_type: z.enum(["video/mp4", "video/webm"]), data: z.string() }),
  },
};

export function nativeToolCatalog() {
  const catalog = createToolCatalog();
  const uri = panelResourceUri(panelResourceInputs());
  const tools: Record<string, unknown>[] = [];
  for (const entry of metadata) {
    const action = operationForTool(entry.name);
    const operation = action ? operations[action] : undefined;
    const connection = connectionCheckTools.find((tool) => tool.name === entry.name);
    let input = operation?.input ?? connection?.input ?? extra[entry.name]?.input;
    if (!input) throw new Error(`Missing input contract: ${entry.name}`);
    if (entry.name === "start_goodfinds_search")
      input = operations.request_search_run.input.extend({
        request: searchCommands.start.extend({ trigger: z.literal("manual").default("manual") }),
      });
    const extraOutput = extra[entry.name]?.output;
    const output =
      operation?.wire ??
      (connection
        ? wireSchema(connectionCheckResultSchema)
        : extraOutput
          ? wireSchema(extraOutput)
          : undefined);
    const advertised = catalog.advertise(entry.name, { ...entry, inputSchema: input.shape });
    const advertisedInput = { ...z.toJSONSchema(advertised.inputSchema, { io: "input" }) };
    // Discovery uses only basic object/enum/array hints. Omit the repeated
    // dialect URI here; full validation schemas retain their declared dialect.
    delete advertisedInput["$schema"];
    const tool: Record<string, unknown> = {
      ...advertised,
      inputSchema: advertisedInput,
      ...(output ? { outputSchema: z.toJSONSchema(output) } : {}),
    };
    if (["open_goodfinds_panel", "start_goodfinds_search"].includes(entry.name)) {
      const meta = z.record(z.string(), z.unknown()).parse(tool["_meta"] ?? {});
      tool["_meta"] = {
        ...meta,
        ui: { ...z.record(z.string(), z.unknown()).parse(meta["ui"] ?? {}), resourceUri: uri },
        "ui/resourceUri": uri,
      };
    }
    tools.push(tool);
  }
  return {
    tools,
    contracts: catalog.contracts,
    resources: [
      {
        name: "Goodfinds",
        title: "Goodfinds",
        uri,
        description: "Search management and deal comparison on this device",
        mimeType: "text/html;profile=mcp-app",
      },
    ],
    instructions: GOODFINDS_MCP_INSTRUCTIONS,
  };
}
