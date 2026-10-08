import type { EventDefinition, GuardDefinition, StateDefinition } from "./workflow-model.ts";

export const sellerActionStatuses = [
  "awaiting_handoff",
  "requested",
  "running",
  "ready_to_send",
  "sent",
  "checked",
  "not_sent",
  "uncertain",
  "blocked",
  "cancelled",
] as const;
export const sellerStates = {
  awaiting_handoff: {
    meaning: "An immutable reviewed action is saved for host handoff.",
    invariant: "The draft is bound to this action; no send permission exists.",
    recovery: "Report host acceptance or cancel before execution.",
  },
  requested: {
    meaning: "Host accepted the action; browser execution is pending.",
    invariant: "Handoff does not prove a message was sent.",
    recovery: "Verify browser access and sign-in, then claim.",
  },
  running: {
    meaning: "An executor holds a lease and must verify the thread.",
    invariant: "Claiming never grants permission to send.",
    recovery: "For send, request one permit; for check, report observed replies.",
  },
  ready_to_send: {
    meaning: "A single-use permit was issued for exact text and identity.",
    invariant: "No second permit may be issued. A workflow descriptor never grants permission.",
    recovery: "Report evidence from the verified thread. Reconcile after interruption.",
  },
  sent: {
    meaning: "The exact outgoing message was observed or reported by the user.",
    invariant: "Provenance distinguishes browser evidence from user reports.",
    recovery: "Check replies or prepare a new reviewed action.",
  },
  checked: {
    meaning: "A verified thread was inspected for replies.",
    invariant: "Message identity and classification evidence are preserved.",
    recovery: "Review new replies before further outreach.",
  },
  not_sent: {
    meaning: "The stopped action has evidence that no outgoing message was sent.",
    invariant: "A send requires verified thread identity to record this result.",
    recovery: "Prepare a new reviewed action if still wanted.",
  },
  uncertain: {
    meaning: "An interrupted send might have reached the seller.",
    invariant: "It cannot be resent, cancelled or granted another permit.",
    recovery: "Claim a reconciliation lease and inspect the same thread.",
  },
  blocked: {
    meaning: "Execution stopped before a potential send, or a check lease expired.",
    invariant: "Potentially sent messages remain uncertain instead.",
    recovery: "Resolve the blocker, cancel or claim again.",
  },
  cancelled: {
    meaning: "The action was cancelled before sending.",
    invariant: "Cancellation cannot erase an uncertain send.",
    recovery: "Prepare a new action if needed.",
  },
} as const satisfies Record<(typeof sellerActionStatuses)[number], StateDefinition>;
export const sellerGuards = {
  conversation_changed: {
    message: "Conversation changed elsewhere. Refresh it before editing or sending.",
    recovery: "Read the conversation and use its current version.",
  },
  conversation_closed: {
    message: "Reopen the conversation before another action.",
    recovery: "Record an open buying outcome before new outreach.",
  },
  pending_action: {
    message:
      "An action already exists. Continue or reconcile the pending send or check before requesting another.",
    recovery: "Resolve or cancel the pending action before creating more work.",
  },
  pending_send: {
    message: "Resolve or cancel the pending send before changing its draft.",
    recovery: "Keep the approved draft and collection terms immutable during a send.",
  },
  draft_missing: {
    message: "Save and review a message first.",
    recovery: "Save the exact reviewed wording before requesting a send.",
  },
  collection_expired: {
    message: "Update the expired collection time before sending.",
    recovery: "Update collection terms and obtain review of the new draft.",
  },
  availability_unchecked: {
    message: "Recheck availability before contacting this seller.",
    recovery: "Observe an active listing before requesting a send permit.",
  },
  reply_unreviewed: {
    message: "The latest seller reply needs review first.",
    recovery: "Review the latest reply and bind the draft's responds_to to it.",
  },
  contact_unverified: {
    message:
      "Check this listing's message interface before preparing outreach. Native offers use the platform offer interface.",
    recovery: "Observe this listing's contact options in the current browser context.",
  },
  marketplace_disabled: {
    message: "This marketplace is disabled in Settings.",
    recovery: "Enable the selected marketplace before browser execution.",
  },
  manual_only: {
    message: "This marketplace currently supports copy/open and manual history.",
    recovery: "Use manual history for sample and unsupported marketplaces.",
  },
  browser_unverified: {
    message: "Check browser access in Settings before this action.",
    recovery: "Observe fresh browser access in this server context.",
  },
  signin_unverified: {
    message: "Facebook messaging requires verified sign-in in this browser profile.",
    recovery: "Verify sign-in in the saved buyer, host and browser profile.",
  },
  executor_active: {
    message: "This action already has an active executor.",
    recovery: "Wait for the current executor or reconcile after its lease expires.",
  },
  lease_expired: {
    message: "Execution lease expired. Claim and reconcile the conversation before continuing.",
    recovery:
      "Claim a current lease token; reconcile an interrupted send before repeating anything.",
  },
  lease_input: {
    message: "Supply the current lease token.",
    recovery: "Use the token from the current claim, never a previous executor's token.",
  },
  permit_already_issued: {
    message: "This action cannot issue another send permit; reconcile the thread first.",
    recovery:
      "Send only after prepare returns a fresh execution.send_permitted true; never reuse or request a second permit.",
  },
  sample_only: {
    message: "Sample conversations support manual practice only; no browser action is permitted",
    recovery: "Use manual history in sample mode.",
  },
  listing_identity: {
    message: "The observed listing does not match the approved item",
    recovery: "Return to the approved canonical item URL and listing ID.",
  },
  seller_identity: {
    message: "The seller does not match this listing",
    recovery: "Verify the seller attached to the approved listing.",
  },
  profile_mismatch: {
    message: "Verify sign-in in the chosen browser profile before this action",
    recovery: "Verify buyer sign-in and contact observations in the same host and profile.",
  },
  identity_unverified: {
    message: "Verify the seller and thread before confirming.",
    recovery: "Verify listing, seller, buyer, host, profile and thread identity.",
  },
  identity_mismatch: {
    message: "Verify the existing seller, buyer and conversation in the same browser profile.",
    recovery: "Return to the approved listing and established seller thread.",
  },
  evidence_required: {
    message: "Confirm the exact outgoing message in the verified thread.",
    recovery:
      "Report observed evidence and exact text; classification needs supporting seller words.",
  },
  action_unclaimed: {
    message: "Claim this action first.",
    recovery: "Claim a browser or reconciliation lease before reporting the result.",
  },
  uncertain_send: {
    message:
      "Verify an interrupted send before cancelling it; a potentially sent message must remain uncertain until reconciled.",
    recovery: "Inspect the verified thread; do not resend or cancel an uncertain send.",
  },
  executor_input: {
    message: "Supply the executor's worker_id.",
    recovery: "Use the actual browser executor's identity.",
  },
  review_required: {
    message: "Sending requires explicit authorization of the exact reviewed text.",
    recovery:
      "Obtain user review of the saved wording. Request records that wording; the server cannot infer user authorization from state.",
  },
  input_required: {
    message: "Supply the proposed action inputs.",
    recovery: "Read the operation schema and supply its required inputs.",
  },
} as const satisfies Record<string, GuardDefinition>;
const idle = ["idle", "sent", "checked", "not_sent", "cancelled", "blocked"];
const route = [
  "sample_only",
  "listing_identity",
  "seller_identity",
  "profile_mismatch",
  "manual_only",
  "marketplace_disabled",
  "browser_unverified",
  "contact_unverified",
  "signin_unverified",
  "identity_mismatch",
];
export const sellerEvents = {
  save_draft: {
    operation: "save_seller_message_draft",
    from: ["idle", ...sellerActionStatuses],
    to: [],
    inputs: ["listing_key", "expected_version", "draft"],
    guards: ["conversation_changed", "pending_send", "input_required"],
    meaning: "Save reviewed wording without creating an execution action.",
  },
  collection_plan: {
    operation: "save_collection_plan",
    from: ["idle", ...sellerActionStatuses],
    to: [],
    inputs: ["listing_key", "expected_version", "plan"],
    guards: ["conversation_changed", "pending_send", "input_required"],
    meaning:
      "Persist collection terms and their confirmation evidence, separately from buying outcome.",
  },
  arrange: {
    operation: "prepare_collection_message",
    from: idle,
    to: [],
    inputs: ["listing_key", "expected_version"],
    guards: ["conversation_changed", "pending_action", "conversation_closed"],
    meaning: "Prepare wording from the saved plan and unresolved questions.",
  },
  request_send: {
    diagram: [{ from: "idle", to: "awaiting_handoff", label: "reviewed draft" }],
    operation: "request_seller_action",
    from: idle,
    to: ["awaiting_handoff"],
    inputs: ["listing_key", "expected_version", "request_id", "kind=send"],
    guards: [
      "conversation_changed",
      "conversation_closed",
      "pending_action",
      "draft_missing",
      "collection_expired",
      "availability_unchecked",
      "reply_unreviewed",
      "contact_unverified",
      "marketplace_disabled",
      "review_required",
      "input_required",
    ],
    meaning:
      "Record the exact reviewed draft. Authorization remains the caller's responsibility; this grants no permit.",
  },
  request_check: {
    execution_profile: "collection",
    operation: "request_seller_action",
    from: idle,
    to: ["awaiting_handoff"],
    inputs: ["listing_key", "expected_version", "request_id", "kind=check"],
    guards: ["conversation_changed", "conversation_closed", "pending_action", "input_required"],
    meaning: "Request observation of replies.",
  },
  handoff: {
    diagram: [{ from: "awaiting_handoff", to: "requested" }],
    operation: "report_seller_action_handoff",
    from: ["awaiting_handoff"],
    to: ["requested"],
    inputs: ["listing_key", "action_id"],
    guards: [],
    meaning: "Record host acceptance; subsequent reports are harmless.",
  },
  cancel: {
    diagram: [{ from: "requested", to: "cancelled" }],
    operation: "cancel_seller_action",
    from: ["awaiting_handoff", "requested", "blocked"],
    to: ["cancelled"],
    inputs: ["listing_key", "action_id"],
    guards: ["uncertain_send"],
    meaning: "Cancel only before a possible send.",
  },
  claim: {
    diagram: [
      { from: "requested", to: "running" },
      { from: "uncertain", to: "uncertain", label: "reconciliation only" },
    ],
    operation: "claim_seller_action",
    from: ["awaiting_handoff", "requested", "running", "ready_to_send", "uncertain", "blocked"],
    to: ["running", "uncertain"],
    inputs: ["listing_key", "action_id", "worker_id"],
    guards: ["executor_active", ...route, "executor_input"],
    meaning: "Claim execution or reconciliation. Claiming never grants a send permit.",
  },
  permit: {
    diagram: [
      { from: "running", to: "ready_to_send", label: "one verified permit" },
      { from: "running", to: "blocked", label: "changed facts" },
    ],
    operation: "issue_message_send_permit",
    from: ["running", "ready_to_send", "uncertain"],
    to: ["ready_to_send", "blocked"],
    inputs: ["listing_key", "action_id", "lease_token", "identity"],
    guards: [
      "lease_expired",
      "lease_input",
      "permit_already_issued",
      ...route,
      "identity_unverified",
      "draft_missing",
      "collection_expired",
      "availability_unchecked",
      "reply_unreviewed",
      "conversation_closed",
    ],
    meaning:
      "Issue one permit after exact identity and draft checks, or pause before sending if facts changed.",
  },
  result: {
    diagram: [
      { from: "ready_to_send", to: "sent", label: "exact outgoing evidence" },
      { from: "running", to: "checked", label: "observed replies" },
      { from: "uncertain", to: "sent", label: "verified outgoing" },
      { from: "uncertain", to: "not_sent", label: "verified absence" },
    ],
    operation: "report_seller_action_result",
    from: ["running", "ready_to_send", "uncertain"],
    to: ["sent", "checked", "not_sent", "uncertain", "blocked"],
    inputs: [
      "listing_key",
      "action_id",
      "lease_token",
      "result",
      "evidence",
      "identity (for sent/check/not_sent send)",
    ],
    guards: [
      "lease_expired",
      "lease_input",
      "action_unclaimed",
      "uncertain_send",
      "evidence_required",
      "identity_unverified",
      ...route,
    ],
    meaning:
      "Record observed results; terminal confirmations are idempotent. Uncertain results require reconciliation.",
  },
  outcome: {
    operation: "set_buying_outcome",
    from: ["idle", ...sellerActionStatuses],
    to: [],
    inputs: ["listing_key", "expected_version", "outcome"],
    guards: ["conversation_changed", "pending_action", "input_required"],
    meaning:
      "Record open/bought/withdrawn/unavailable independently of conversation phase. Only bought fulfils a buying goal.",
  },
  inspect: {
    operation: "get_seller_conversation",
    from: ["idle", ...sellerActionStatuses],
    to: [],
    inputs: ["listing_key"],
    guards: [],
    meaning:
      "Read conversation phase, buying outcome and execution guidance. Existing expired actions are reconciled by the server.",
  },
  expire: {
    diagram: [
      { from: "ready_to_send", to: "uncertain", label: "send" },
      { from: "running", to: "uncertain", label: "send" },
      { from: "running", to: "blocked", label: "check" },
    ],
    operation: null,
    from: ["running", "ready_to_send"],
    to: ["uncertain", "blocked"],
    inputs: [],
    guards: ["lease_expired"],
    meaning: "An expired send becomes uncertain; an expired check becomes blocked.",
  },
} as const satisfies Record<string, EventDefinition>;
