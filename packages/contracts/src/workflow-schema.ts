import { verificationCheckSchema } from "./verification.ts";
import { buyingNextStepSchema } from "./buying-next-steps.ts";
import { z } from "zod";
import { operationNames, isOperationName } from "./tool-names.ts";
import { executionPolicySchema } from "./worker-execution.ts";

export const blockerSchema = z.object({
  code: z.string(),
  message: z.string(),
  recovery: z.string(),
  kind: z.enum(["input", "blocked"]),
});
export const actionDescriptorSchema = z.object({
  event: z.string(),
  operation: z.enum(Object.keys(operationNames).filter(isOperationName)),
  tool: z.string(),
  availability: z.enum(["available", "requires_input", "blocked"]),
  required_inputs: z.array(z.string()),
  conditions: z.array(z.string()),
  blockers: z.array(blockerSchema),
  execution: executionPolicySchema,
});
export const workflowSchema = z.object({
  state: z.string(),
  actions: z.array(actionDescriptorSchema),
  allowed_actions: z.array(z.string()),
  prerequisites: z.array(z.string()),
});
export const sellerWorkflowSchema = workflowSchema.extend({
  conversation_phase: z.string(),
  buying_outcome: z.string(),
  action_id: z.string().nullable(),
});

export const listingWorkflowSchema = workflowSchema.extend({
  availability: z.object({
    state: z.enum(["active", "reserved", "unavailable", "unknown"]),
    observed: z.string(),
  }),
  evidence: z.object({
    state: z.enum(["discovery", "needs_check", "conflicting", "resolved"]),
    checks: z.array(verificationCheckSchema),
    quality: z.record(z.string(), z.unknown()).nullable(),
  }),
  media: z.object({
    state: z.enum(["pending", "unavailable", "complete"]),
    retry_at: z.string().nullable(),
    ready: z.boolean(),
    image_reviewed: z.boolean(),
    video_reviewed: z.boolean(),
  }),
  assessments: z.array(
    z.object({
      search_id: z.string(),
      suitability: z.enum(["suitable", "possible", "unsuitable", "unevaluated"]),
      verification: z.enum(["complete", "needs_check"]),
      value: z.enum(["below_average", "at_or_above_average", "unknown"]),
      dismissed: z.boolean(),
      reasons: z.array(z.string()),
      checks: z.array(verificationCheckSchema),
      next_step: buyingNextStepSchema.nullable(),
    }),
  ),
  conversation_phase: z.string(),
  buying_outcome: z.string(),
});
