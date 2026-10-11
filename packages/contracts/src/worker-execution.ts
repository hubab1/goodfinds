import { z } from "zod";

export const executionProfileNames = ["chat", "collection", "browser_collection"] as const;
export type ExecutionProfile = (typeof executionProfileNames)[number];
export const executionProfiles = {
  chat: {
    meaning: "Use the buying chat's model and reasoning for decisions and judgment.",
    spawn: {},
  },
  collection: {
    meaning:
      "Collect explicit facts and media against a saved brief; return ambiguity to the buying chat.",
    spawn: { model: "gpt-6-luna", reasoning_effort: "xhigh", fork_turns: "none" },
  },
  browser_collection: {
    meaning:
      "Use the buying chat's model and reasoning for marketplace navigation and evidence collection, with only the saved brief as context.",
    spawn: { fork_turns: "none" },
  },
} as const;
export const workerTasks = {
  connection_check: {
    profile: "collection",
    meaning:
      "Observe browser control and marketplace sign-in in a claimed read-only native subagent check.",
  },
  search_collection: {
    profile: "browser_collection",
    meaning: "Discover listings, paginate and extract sourced facts from the saved query plan.",
  },
  listing_evidence: {
    profile: "browser_collection",
    meaning:
      "Inspect saved shortlist evidence against explicit checks and preserve unknowns or conflicts.",
  },
  media_repair: {
    profile: "browser_collection",
    meaning:
      "Recover listing photos and videos without rewriting fact timestamps or review coverage.",
  },
  contact_check: {
    profile: "collection",
    meaning: "Observe the selected listing's contact interface and browser identity.",
  },
  reply_check: {
    profile: "collection",
    meaning: "Read the verified seller thread and record exact replies with supporting evidence.",
  },
  buying_judgment: {
    profile: "chat",
    meaning:
      "Interpret preferences, research product tradeoffs, compare options and resolve ambiguous or conflicting evidence.",
  },
  seller_message: {
    profile: "chat",
    meaning:
      "Review wording, negotiate and perform an exact reviewed send under its existing permit.",
  },
  monitoring: {
    profile: "chat",
    meaning: "Make setup and scheduling choices in the original buying chat.",
  },
} as const satisfies Record<string, { profile: ExecutionProfile; meaning: string }>;

export const executionPolicySchema = z.discriminatedUnion("profile", [
  z.object({ profile: z.literal("chat"), spawn: z.object({}).strict() }).strict(),
  z
    .object({
      profile: z.literal("browser_collection"),
      spawn: z.object({ fork_turns: z.literal("none") }).strict(),
    })
    .strict(),
  z
    .object({
      profile: z.literal("collection"),
      spawn: z
        .object({
          model: z.literal(executionProfiles.collection.spawn.model),
          reasoning_effort: z.literal(executionProfiles.collection.spawn.reasoning_effort),
          fork_turns: z.literal(executionProfiles.collection.spawn.fork_turns),
        })
        .strict(),
    })
    .strict(),
]);
export function executionPolicy(profile: ExecutionProfile) {
  if (profile === "browser_collection")
    return { profile, spawn: executionProfiles.browser_collection.spawn };
  return profile === "collection"
    ? { profile: "collection" as const, spawn: executionProfiles.collection.spawn }
    : { profile: "chat" as const, spawn: executionProfiles.chat.spawn };
}
/** Host-reported settings, not proof of inference quality or execution permission. */
export const workerExecutionSchema = z
  .object({
    profile: z.enum(executionProfileNames),
    model: z.string().trim().min(1).max(200),
    reasoning_effort: z
      .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
      .optional(),
  })
  .strict();

export const WORKER_ROUTING_GUIDANCE = `Use native background workers for collection. For listing discovery, pagination, explicit fact/image checks and media recovery, use the browser_collection profile: fork_turns: "none" and omit model and reasoning overrides so the worker inherits the buying chat's settings. For read-only connection/contact/reply checks, use the collection profile: model: "${executionProfiles.collection.spawn.model}", reasoning_effort: "${executionProfiles.collection.spawn.reasoning_effort}", fork_turns: "${executionProfiles.collection.spawn.fork_turns}". Pass the current saved brief and IDs explicitly. Keep buying decisions, ambiguous/conflicting evidence, seller-message review/sends and scheduling in the buying chat. Workers save sourced evidence and return ambiguity to it. If overrides are unsupported or the requested model is unavailable, inherit the buying chat and report the fallback. Record actual host-reported model/effort in claim.execution when known; leave it absent when unknown. Read references/state-model.md#worker-model-routing and references/background-work.md for dispatch and completion.`;
