import { z } from "zod";

// Agent Plugin hosts repeat namespace instructions per tool and cap the combined
// catalogue at 64 KB. Keep validation contracts separate from discovery hints.
export const GOODFINDS_MCP_INSTRUCTIONS = "Use the marketplace-shopping skill.";

type Schema = Record<string, unknown>;
const objectSchema = z.record(z.string(), z.unknown());
export type FullToolContract = { name: string; description: string; inputSchema: Schema };
const descriptions: Record<string, string> = {
  get_goodfinds_setup_context:
    "Start a brief: category returns a starter definition, regional settings and scoped revisions. Use the buyer's supplied answers; save complete briefs directly.",
  save_goodfinds_search:
    "Save a brief using the setup template and scoped revision. Set initial_monitoring.preference=once for one-off requests. Follow panel handoff for the first display; edits reuse the existing panel. Read the full schema for custom definitions.",
  start_goodfinds_search:
    "Queue a manual run and request the first panel display in this buying chat. Every call can open another tab. After a panel was shown, use request_goodfinds_search_run instead. Claim the returned run to execute it.",
  request_goodfinds_search_run:
    "Queue or reuse a run without opening a panel. Use for manual searches after a panel was shown, retries and workers. Use trigger=scheduled for automation wake-ups and honor skipped checks.",
  claim_goodfinds_search_run:
    "Claim a run before browsing using the actual executor's agent ID or canonical task name and a new worker UUID. A direct single-platform search may execute in the buying chat. Renew its lease during work.",
  get_goodfinds_tool_schema:
    "Read the full input schema and guidance for one tool when a nested object's fields are absent from its compact schema. Reuse returned setup templates when available.",
};
const structuralKeys = new Set(["type", "enum", "const", "required", "additionalProperties"]);
function compact(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const node = objectSchema.parse(value);
  if (depth >= 2 && node["type"] === "object" && node["properties"])
    return { type: "object", additionalProperties: true };
  const result: Schema = {};
  for (const [key, child] of Object.entries(node)) {
    if (key === "properties") {
      result[key] = Object.fromEntries(
        Object.entries(objectSchema.parse(child)).map(([name, field]) => [
          name,
          compact(field, depth + 1),
        ]),
      );
    } else if (key === "items") result[key] = compact(child, depth);
    else if (["anyOf", "oneOf", "allOf"].includes(key) && Array.isArray(child)) {
      // Relaxed variants can overlap; oneOf would make identical objects invalid.
      result[key === "oneOf" ? "anyOf" : key] = child.map((entry) => compact(entry, depth));
    } else if (structuralKeys.has(key))
      result[key] = key === "additionalProperties" ? compact(child, depth) : child;
  }
  return result;
}

export function createToolCatalog() {
  const contracts: Record<string, FullToolContract> = {};
  function advertise<T extends { description: string; inputSchema: z.ZodRawShape }>(
    name: string,
    config: T,
  ) {
    const schema = z.object(config.inputSchema);
    const inputSchema = z.toJSONSchema(schema, { io: "input" });
    contracts[name] = { name, description: config.description, inputSchema };
    const advertised = objectSchema.parse(compact(inputSchema));
    const properties = objectSchema.parse(advertised["properties"]);
    advertised["properties"] = properties;
    const required = z.array(z.string()).parse(advertised["required"] ?? []);
    for (const key of ["context_id", "expected_entity_revision", "expected_draft_revision"]) {
      if (
        !required.includes(key) &&
        !(key === "expected_draft_revision" && name === "save_goodfinds_search")
      )
        delete properties[key];
    }
    // Saved and new search variants differ in defaults/required IDs, but share the
    // same writable fields. The full union remains the runtime validator.
    for (const key of ["search", "draft"]) {
      const child = objectSchema.optional().parse(properties[key]);
      const variants = child?.["anyOf"];
      if (Array.isArray(variants)) properties[key] = variants[0];
    }
    return {
      ...config,
      description:
        descriptions[name] ?? config.description.split(/(?<=[.!?])\s/u)[0] ?? config.description,
      // Public Zod metadata changes JSON-schema export, not parsing/validation.
      inputSchema: schema.meta(advertised),
    };
  }
  return { advertise, contracts };
}
