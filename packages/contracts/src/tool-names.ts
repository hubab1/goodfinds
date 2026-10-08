// Lightweight shared names: the panel does not load server result-schema machinery.
export const operationNames = {
  get_workspace: ["open_goodfinds_panel", "get_goodfinds_workspace"],
  get_settings: ["get_goodfinds_settings"],
  list_activity: ["list_goodfinds_activity"],
  get_monitoring: ["get_goodfinds_monitoring"],
  list_next_steps: ["list_goodfinds_next_steps"],
  prepare_next_steps: ["prepare_goodfinds_next_steps"],
  get_search_context: ["get_goodfinds_search_context"],
  list_listings: ["list_goodfinds_listings"],
  set_listing_seen: ["set_goodfinds_listing_seen"],
  get_listing: ["get_goodfinds_listing"],
  list_media_repairs: ["list_goodfinds_media_repairs"],
  list_journey_checks: ["list_goodfinds_journey_checks"],
  record_journey_check: ["record_goodfinds_journey_check"],
  check_scheduled_search: ["check_goodfinds_scheduled_search"],
  get_dispatcher_context: ["get_goodfinds_dispatcher_context"],
  request_scheduled_batch: ["request_goodfinds_scheduled_batch"],
  report_dispatcher_schedule: ["report_goodfinds_dispatcher_schedule"],
  list_search_runs: ["list_goodfinds_search_runs"],
  request_search_run: ["request_goodfinds_search_run"],
  claim_search_run: ["claim_goodfinds_search_run"],
  renew_search_lease: ["renew_goodfinds_search_lease"],
  cancel_search_run: ["cancel_goodfinds_search_run"],
  update_search_run: ["update_goodfinds_search_run"],
  save_search: ["save_goodfinds_search"],
  set_search_cover: ["set_goodfinds_search_cover"],
  save_search_draft: ["save_goodfinds_search_draft"],
  discard_search_draft: ["discard_goodfinds_search_draft"],
  set_monitoring: ["set_goodfinds_monitoring"],
  report_host_schedule: ["report_goodfinds_host_schedule"],
  set_search_enabled: ["set_goodfinds_search_enabled"],
  remove_search: ["remove_goodfinds_search"],
  save_settings: ["save_goodfinds_settings"],
  report_browser_access: ["report_goodfinds_browser_access"],
  report_listing_contact: ["report_goodfinds_listing_contact"],
  report_marketplace_session: ["report_goodfinds_marketplace_session"],
  record_listing_feedback: ["record_goodfinds_listing_feedback"],
  undo_listing_feedback: ["undo_goodfinds_listing_feedback"],
  load_sample_workspace: ["load_goodfinds_sample_workspace"],
  import_listing_observations: ["import_goodfinds_listing_observations"],
  attach_listing_media: ["attach_goodfinds_listing_media"],
  report_connections: [],
  save_collection_plan: ["save_goodfinds_collection_plan"],
  prepare_collection_message: ["prepare_goodfinds_collection_message"],
  get_seller_conversation: ["get_goodfinds_seller_conversation"],
  save_seller_message_draft: ["save_goodfinds_seller_message_draft"],
  request_seller_action: ["request_goodfinds_seller_action"],
  report_seller_action_handoff: ["report_goodfinds_seller_action_handoff"],
  cancel_seller_action: ["cancel_goodfinds_seller_action"],
  claim_seller_action: ["claim_goodfinds_seller_action"],
  issue_message_send_permit: ["issue_goodfinds_message_send_permit"],
  report_seller_action_result: ["report_goodfinds_seller_action_result"],
  record_user_reported_message: ["record_goodfinds_user_reported_message"],
  correct_reply_interpretation: ["correct_goodfinds_reply_interpretation"],
  set_buying_outcome: ["set_goodfinds_buying_outcome"],
} as const;
export type OperationName = keyof typeof operationNames;
export function isOperationName(name: string): name is OperationName {
  return Object.hasOwn(operationNames, name);
}
export function operationForTool(name: string): OperationName | undefined {
  return Object.keys(operationNames)
    .filter(isOperationName)
    .find((key) => operationNames[key].some((tool) => tool === name));
}

export const searchRunActions = {
  request_search_run: "start",
  claim_search_run: "claim",
  renew_search_lease: "heartbeat",
  cancel_search_run: "cancel",
  update_search_run: "update",
} as const;
export const sellerActions = {
  save_collection_plan: "plan",
  prepare_collection_message: "arrange",
  get_seller_conversation: "get",
  save_seller_message_draft: "save",
  request_seller_action: "request",
  report_seller_action_handoff: "handoff",
  cancel_seller_action: "cancel",
  claim_seller_action: "claim",
  issue_message_send_permit: "prepare",
  report_seller_action_result: "complete",
  record_user_reported_message: "manual",
  correct_reply_interpretation: "correct",
  set_buying_outcome: "outcome",
} as const;
export const searchRunAction = (name: string) =>
  Object.entries(searchRunActions).find(([key]) => key === name)?.[1];
export const sellerAction = (name: string) =>
  Object.entries(sellerActions).find(([key]) => key === name)?.[1];
