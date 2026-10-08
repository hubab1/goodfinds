import { z } from "zod";
import {
  accessReportSchema,
  browserSchema,
  marketplaceSchema,
  sessionReportSchema,
} from "./integrations";
import { executionPolicySchema, workerExecutionSchema } from "./worker-execution";
import type { StateDefinition } from "./workflow-model";

export const connectionCheckStates = {
  queued: {
    meaning: "Waiting for a native subagent claim.",
    invariant: "No browser work or verified observations yet.",
    recovery: "Dispatch one scoped subagent; record unavailable if delegation fails.",
  },
  running: {
    meaning: "A worker owns the read-only check.",
    invariant: "A live worker claim is required for renewal and completion.",
    recovery: "Reuse the claimed worker; stop on cancellation, expiry or a changed browser route.",
  },
  complete: {
    meaning: "Validated observations have been saved.",
    invariant: "Unchecked targets remain unknown; public access does not establish sign-in.",
    recovery: "Start a new check to refresh or cover unchecked targets.",
  },
  unavailable: {
    meaning: "Delegation or the selected browser route is unavailable.",
    invariant: "No fabricated account evidence or foreground fallback.",
    recovery: "Resolve the recorded limitation, then start a new check.",
  },
  cancelled: {
    meaning: "The buyer stopped the check.",
    invariant: "Further claims and result writes are rejected.",
    recovery: "Keep prior evidence; start a new check if requested.",
  },
  failed: {
    meaning: "The check could not finish.",
    invariant: "A failure is not proof of sign-out.",
    recovery: "Read the reason and retry with a new check.",
  },
  interrupted: {
    meaning: "Dispatch or a worker lease expired, or execution stopped.",
    invariant: "The expired worker cannot save late results.",
    recovery: "Preserve evidence and start a new check.",
  },
} as const satisfies Record<string, StateDefinition>;
export const connectionCheckStatuses = [
  "queued",
  "running",
  "complete",
  "unavailable",
  "cancelled",
  "failed",
  "interrupted",
] as const;
export const CONNECTION_CHECK_DISPATCH_MS = 2 * 60_000;
export const CONNECTION_CHECK_LEASE_MS = 2 * 60_000;
export const CONNECTION_CHECK_TIMEOUT_MS = 5 * 60_000;
export function connectionCheckActive(run: { status: string } | null | undefined): boolean {
  return run?.status === "queued" || run?.status === "running";
}

export const connectionCheckWorkerSchema = z
  .object({
    id: z.uuid(),
    agent_id: z.string().trim().min(1).max(200),
    parent_thread_id: z.string().trim().min(1).max(200).optional(),
    claimed_at: z.iso.datetime(),
    last_heartbeat_at: z.iso.datetime(),
    execution: workerExecutionSchema.optional(),
  })
  .strict();

export const connectionCheckTargetSchema = z
  .object({
    marketplace: marketplaceSchema,
    browser: browserSchema,
    browser_id: z.string().trim().min(1).max(200).nullable(),
  })
  .strict();
export type ConnectionCheckTarget = z.infer<typeof connectionCheckTargetSchema>;

export const connectionCheckObservationSchema = z
  .object({
    marketplace: marketplaceSchema,
    access: accessReportSchema,
    session: sessionReportSchema.nullable(),
  })
  .strict();
export type ConnectionCheckObservation = z.infer<typeof connectionCheckObservationSchema>;

export const connectionCheckRunSchema = z
  .object({
    id: z.uuid(),
    request_id: z.uuid(),
    version: z.number().int().positive().default(1),
    context_id: z.string(),
    status: z.enum(connectionCheckStatuses),
    worker: connectionCheckWorkerSchema.nullable().default(null),
    message: z.string().max(300),
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
    targets: z.array(connectionCheckTargetSchema).max(6),
    results: z
      .array(
        z
          .object({
            marketplace: marketplaceSchema,
            browser: browserSchema,
            status: z.enum(["signed_in", "signed_out", "unknown"]),
            checked_at: z.iso.datetime().nullable(),
          })
          .strict(),
      )
      .max(6),
  })
  .strict();
export type ConnectionCheckRun = z.infer<typeof connectionCheckRunSchema>;

export const connectionCheckResultSchema = z.object({
  run: connectionCheckRunSchema.nullable(),
  execution: executionPolicySchema,
});
export type ConnectionCheckResult = z.infer<typeof connectionCheckResultSchema>;

export const startConnectionCheckSchema = z
  .object({
    mode: z.enum(["live", "sample"]).default("live"),
    expected_entity_revision: z.string().regex(/^[a-f0-9]{64}$/),
    request_id: z.uuid(),
    marketplaces: z.array(marketplaceSchema).min(1).max(6).optional(),
  })
  .strict();
export const readConnectionCheckSchema = z
  .object({
    mode: z.enum(["live", "sample"]).default("live"),
    run_id: z.uuid().optional(),
  })
  .strict();
export const cancelConnectionCheckSchema = readConnectionCheckSchema.extend({ run_id: z.uuid() });

const versionedCheckSchema = cancelConnectionCheckSchema.extend({
  expected_version: z.number().int().positive(),
});
export const claimConnectionCheckSchema = versionedCheckSchema.extend({
  worker_id: z.uuid(),
  agent_id: z.string().trim().min(1).max(200),
  parent_thread_id: z.string().trim().min(1).max(200).optional(),
  execution: workerExecutionSchema.optional(),
});
export const renewConnectionCheckSchema = cancelConnectionCheckSchema.extend({
  worker_id: z.uuid(),
});
export const completeConnectionCheckSchema = versionedCheckSchema.extend({
  worker_id: z.uuid(),
  observations: z.array(connectionCheckObservationSchema).min(1).max(6),
});
export const interruptConnectionCheckSchema = versionedCheckSchema.extend({
  worker_id: z.uuid().optional(),
  status: z.enum(["unavailable", "failed", "interrupted"]),
  reason: z.string().trim().min(1).max(300),
});

export const connectionCheckTools = [
  {
    action: "start",
    name: "start_goodfinds_connection_check",
    title: "Request marketplace check",
    input: startConnectionCheckSchema,
    description:
      "Queue a read-only check of selected enabled marketplaces in their saved browser routes. This tool does not launch or browse. The parent must dispatch a native background subagent using references/background-work.md#connection-checks and the returned execution settings, then return promptly. Reuse a running worker; if delegation fails, interrupt the queued check as unavailable without foreground browsing. Use a fresh request_id for new work and the same ID for retries.",
  },
  {
    action: "read",
    name: "get_goodfinds_connection_check",
    title: "Read marketplace check progress",
    input: readConnectionCheckSchema,
    description:
      "Read one durable connection check, or the latest in the current access context. Queued means dispatch is pending; only a worker claim establishes running. Check current status before each browser step. Expired, cancelled or changed-context checks cannot accept results.",
  },
  {
    action: "claim",
    name: "claim_goodfinds_connection_check",
    title: "Claim marketplace check",
    input: claimConnectionCheckSchema,
    description:
      "Called by the dispatched native subagent before browser work. Claim the exact queued check with its current version, fresh worker_id and actual host-provided agent_id. Reuse a matching existing claim; never invent a native identity. Optional execution records actual host-reported model/effort. Identity is caller-reported, not host attestation.",
  },
  {
    action: "renew",
    name: "renew_goodfinds_connection_check",
    title: "Renew marketplace check worker",
    input: renewConnectionCheckSchema,
    description:
      "Renew the owning worker's connection-check lease at least once a minute and before/after slow browser steps. Read the returned version before completion. A cancelled or expired claim cannot be revived; keep the main chat available.",
  },
  {
    action: "complete",
    name: "complete_goodfinds_connection_check",
    title: "Save marketplace check observations",
    input: completeConnectionCheckSchema,
    description:
      "The claimed subagent saves paired observed browser-access and sign-in evidence for the selected routes using its worker_id and current version. Verify actual host/browser/profile identity; public access does not prove sign-in. Unsupported targets may be omitted and remain unknown. Do not use standalone access/session reporting tools to bypass this job's cancellation and ownership checks.",
  },
  {
    action: "interrupt",
    name: "interrupt_goodfinds_connection_check",
    title: "Record marketplace check interruption",
    input: interruptConnectionCheckSchema,
    description:
      "Record the actual delegation/browser limitation or failure. The parent may stop an unclaimed queued check; a running check requires the owning worker_id. Use unavailable for missing delegation or browser capability. Preserve previous account evidence and selected routes; do not perform a foreground fallback.",
  },
  {
    action: "cancel",
    name: "cancel_goodfinds_connection_check",
    title: "Cancel marketplace check",
    input: cancelConnectionCheckSchema,
    description:
      "Cancel a queued or running connection check. The worker must stop at its next status/lease check and close only its own tabs. Further result writes are rejected. Does not sign out, change permissions or discard previous evidence.",
  },
] as const;
