import type { Listing, GoodfindsState, Decision } from "./state.ts";
import { verificationChecks } from "./verification.ts";
import { listingIsDismissed } from "./listing-query.ts";
import { blocker, describeAction, workflow } from "./workflow-model.ts";
import type { EventDefinition, GuardDefinition, StateDefinition } from "./workflow-model.ts";

export type MediaFacts = {
  photos?: readonly unknown[] | undefined;
  videos?: readonly unknown[] | undefined;
  media_capture?:
    | {
        status: "complete" | "partial" | "unavailable";
        expected_photos?: number | undefined;
        expected_videos?: number | undefined;
        captured_at?: string | undefined;
      }
    | undefined;
};
export type MediaRepairListing = MediaFacts & {
  key: string;
  title: string;
  url: string;
  product: string;
};
export function mediaState(row: MediaFacts, now: number) {
  const capture = row.media_capture;
  const incomplete =
    !capture ||
    capture.status !== "complete" ||
    (capture.expected_photos ?? 0) > (row.photos?.length ?? 0) ||
    (capture.expected_videos ?? 0) > (row.videos?.length ?? 0);
  const retry =
    incomplete && capture?.status !== "complete" && capture?.captured_at
      ? Date.parse(capture.captured_at) + 86_400_000
      : null;
  return {
    state: incomplete
      ? capture?.status === "unavailable"
        ? "unavailable"
        : "pending"
      : "complete",
    retry_at: retry === null ? null : new Date(retry).toISOString(),
    ready: incomplete && (retry === null || now >= retry),
  };
}
export const listingDimensions = {
  availability: {
    active: {
      meaning: "The latest successful observation says active.",
      invariant: "Freshness and conflicts are separate evidence checks.",
      recovery: "Recheck before outreach if quality flags require it.",
    },
    reserved: {
      meaning: "The seller reports reserved.",
      invariant: "Reserved is not confirmed active or purchased by this buyer.",
      recovery: "Observe current availability.",
    },
    unavailable: {
      meaning: "The observed item is sold, removed, expired or otherwise unavailable.",
      invariant: "The original availability value remains in the listing.",
      recovery: "Search for alternatives.",
    },
    unknown: {
      meaning: "Availability has not been established.",
      invariant: "Missing evidence is not proof of unavailability.",
      recovery: "Observe the listing.",
    },
  },
  evidence: {
    discovery: {
      meaning: "Only provisional discovery has been recorded.",
      invariant: "Discovery cannot establish a complete gallery review.",
      recovery: "Inspect the listing and unresolved checks.",
    },
    needs_check: {
      meaning: "Verification has unresolved or missing details.",
      invariant: "Unknown, missing and conflicting checks retain distinct meanings.",
      recovery: "Read check evidence and resolve the specific questions.",
    },
    conflicting: {
      meaning: "Saved facts or verification checks disagree.",
      invariant: "Do not silently resolve conflicts by saving media.",
      recovery: "Reinspect the conflicting fields.",
    },
    resolved: {
      meaning: "Every represented verification check is confirmed.",
      invariant: "Search-specific evaluation and availability quality remain separate.",
      recovery: "Review the per-search next step.",
    },
  },
  media: {
    pending: {
      meaning: "Saved gallery capture is incomplete or unknown.",
      invariant: "Capture does not imply review.",
      recovery: "Use the repair queue after discovery; respect retry_at.",
    },
    unavailable: {
      meaning: "The last capture attempt could not recover the gallery.",
      invariant: "Failed media recovery does not rewrite fact timestamps.",
      recovery: "Retry when the queue is ready.",
    },
    complete: {
      meaning: "The represented gallery is saved.",
      invariant: "Image and video review coverage remains independent.",
      recovery: "Review the saved images and videos.",
    },
  },
  assessment: {
    suitable: {
      meaning: "A listing meets one saved search's known requirements.",
      invariant: "Suitability does not prove verification, value or purchase.",
      recovery: "Read verification, value and next-step guidance for this search.",
    },
    possible: {
      meaning: "Some required facts need confirmation.",
      invariant: "One search's assessment does not apply to another search.",
      recovery: "Resolve the search-specific unknowns.",
    },
    unsuitable: {
      meaning: "Known facts fail one search's requirements.",
      invariant: "Other searches may still consider the listing suitable.",
      recovery: "Review reasons or refine that search.",
    },
    unevaluated: {
      meaning: "No current evaluation exists for this search.",
      invariant: "Do not infer suitability from another search or old evidence.",
      recovery: "Refresh search coverage and evidence.",
    },
  },
} as const satisfies Record<string, Record<string, StateDefinition>>;
export const listingGuards = {
  evidence_input: {
    message: "Supply newly observed listing evidence.",
    recovery:
      "Import an observation with its own fact timestamp; claimed runs also require the current worker_id.",
  },
  media_input: {
    message: "Supply recovered media and observed gallery totals.",
    recovery: "Attach media without advancing old fact timestamps or review coverage.",
  },
  media_retry: {
    message: "Media recovery is waiting for its retry time.",
    recovery: "Read the media repair queue and wait until retry_at.",
  },
  feedback_input: {
    message: "Supply the buyer's feedback and current entity revision.",
    recovery: "Use the chosen search_id; category/global scope requires the buyer's intent.",
  },
  search_input: {
    message: "Choose a saved search for this listing.",
    recovery: "Pass search_id to get_goodfinds_listing for a scoped assessment.",
  },
} as const satisfies Record<string, GuardDefinition>;
export const listingEvents = {
  observe: {
    execution_profile: "collection",
    operation: "import_listing_observations",
    from: ["listing"],
    to: [],
    inputs: ["observations", "request_id", "run_id/worker_id (when claimed)"],
    guards: ["evidence_input"],
    meaning: "Append observations and reevaluate with existing matching and quality rules.",
  },
  recover_media: {
    execution_profile: "collection",
    operation: "attach_listing_media",
    from: ["listing"],
    to: [],
    inputs: ["listing_key", "photos", "videos", "media_capture"],
    guards: ["media_input"],
    meaning: "Recover a saved gallery independently of fact observation and review.",
  },
  feedback: {
    operation: "record_listing_feedback",
    from: ["listing"],
    to: [],
    inputs: [
      "expected_entity_revision",
      "feedback.search_id",
      "feedback.listing_key",
      "feedback.action",
    ],
    guards: ["search_input", "feedback_input"],
    meaning: "Record dismissal/shortlist/preference in its explicit scope.",
  },
  inspect_repairs: {
    operation: "list_media_repairs",
    from: ["listing"],
    to: [],
    inputs: [],
    guards: [],
    meaning: "Read recovery readiness and retry time before repeating browser capture.",
  },
  inspect_conversation: {
    operation: "get_seller_conversation",
    from: ["listing"],
    to: [],
    inputs: ["listing_key"],
    guards: [],
    meaning: "Read seller execution, conversation phase and buying outcome separately.",
  },
} as const satisfies Record<string, EventDefinition>;
type ListingContext = Pick<GoodfindsState, "config" | "next_steps" | "seller_conversations"> & {
  decisions: (Pick<Decision, "search_id" | "suitability" | "verification" | "value" | "reasons"> & {
    listing: { key: string };
  })[];
};
export function listingWorkflow(
  row: Listing,
  state: ListingContext,
  now: number,
  searchId?: string,
) {
  const related = state.config.searches.filter(
    (s) => s.product === row.product && (!searchId || s.id === searchId),
  );
  const media = mediaState(row, now);
  const checks = verificationChecks(row);
  const conflict =
    checks.some((c) => c.state === "conflicting") ||
    row.quality?.flags.some((f) => f.code === "conflicting_evidence");
  const assessment = related.map((search) => {
    const decision = state.decisions.find(
      (d) => d.search_id === search.id && d.listing.key === row.key,
    );
    return {
      search_id: search.id,
      suitability: decision?.suitability ?? "unevaluated",
      verification: decision?.verification ?? "needs_check",
      value: decision?.value ?? "unknown",
      dismissed: listingIsDismissed(row, [search], state.config.feedback),
      reasons: decision?.reasons ?? [],
      checks: verificationChecks(row, search.discovery?.verification_checks),
      next_step:
        state.next_steps.find((n) => n.listing_key === row.key && n.search_id === search.id) ??
        null,
    };
  });
  const actions = Object.entries(listingEvents).map(([name, definition]) => {
    const blockers = definition.guards.map((code) => blocker(listingGuards, code, "input"));
    if (name === "feedback" && searchId && related.length)
      blockers.splice(
        blockers.findIndex((b) => b.code === "search_input"),
        1,
      );
    return describeAction(
      name,
      name === "observe" && conflict ? { ...definition, execution_profile: "chat" } : definition,
      listingGuards,
      blockers,
    );
  });
  const conversation = state.seller_conversations.find((c) => c.listing_key === row.key);
  return {
    ...workflow("listing", actions),
    availability: {
      state:
        row.availability === "active" || row.availability === "reserved"
          ? row.availability
          : !row.availability || row.availability === "unknown"
            ? "unknown"
            : "unavailable",
      observed: row.availability ?? "unknown",
    },
    evidence: {
      state: conflict
        ? "conflicting"
        : row.collection_stage === "discovery"
          ? "discovery"
          : checks.some((c) => c.state !== "confirmed")
            ? "needs_check"
            : "resolved",
      checks,
      quality: row.quality ?? null,
    },
    media: {
      ...media,
      image_reviewed: row.image_review?.complete ?? false,
      video_reviewed: row.video_review?.complete ?? false,
    },
    assessments: assessment,
    conversation_phase: conversation?.phase ?? "not_contacted",
    buying_outcome: conversation?.outcome ?? "open",
  };
}
