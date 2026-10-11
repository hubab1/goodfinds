import { z } from "zod";

export const hostCapabilityName = z.enum([
  "panel",
  "browser",
  "delegation",
  "local_files",
  "scheduling",
  "notifications",
]);
export const capabilityStatus = z.enum(["unknown", "advertised", "observed", "unavailable"]);
export const hostCapabilityReportSchema = z
  .object({
    host: z.string().trim().min(1).max(120),
    capabilities: z.partialRecord(
      hostCapabilityName,
      z
        .object({
          status: capabilityStatus,
          evidence: z.string().trim().min(1).max(1000),
        })
        .strict(),
    ),
  })
  .strict();
export const savedHostCapabilitiesSchema = hostCapabilityReportSchema.extend({
  context_id: z.string(),
  checked_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
});
export const runtimeContextSchema = z.object({
  access_context: z.string(),
  contract: z.object({
    workflow_version: z.number().int(),
    plugin_version: z.string(),
    skill: z.literal("marketplace-shopping"),
  }),
  capabilities: z.array(
    z.object({
      name: hostCapabilityName,
      status: capabilityStatus,
      evidence: z.string().nullable(),
      checked_at: z.iso.datetime().nullable(),
      expires_at: z.iso.datetime().nullable(),
    }),
  ),
  schedule_bindings: z.array(
    z.object({
      dispatcher_id: z.uuid(),
      thread_id: z.uuid(),
      status: z.enum(["active", "paused", "removed", "blocked"]).nullable(),
      compatibility: z.enum(["current", "unknown", "stale"]),
      next_step: z.string(),
    }),
  ),
});
