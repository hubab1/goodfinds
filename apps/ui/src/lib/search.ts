import type { App } from "@modelcontextprotocol/ext-apps";
import { hostRequest } from "@goodfinds/contracts/host-request";

export type SearchRequestResult = "sent";
export const AUTOMATION_UNAVAILABLE =
  "Automatic actions aren't available here. Open Goodfinds in the connected app.";

export function requireMessageHost(app: Pick<App, "getHostCapabilities">): void {
  if (!app.getHostCapabilities()?.message?.text) throw new Error(AUTOMATION_UNAVAILABLE);
}

export function searchRequest(searchId?: string, runIds: string[] = []): string {
  const scope = searchId
    ? `only the saved search with ID ${JSON.stringify(searchId)} once even if paused, leaving its enabled/paused setting unchanged. Do not run the other saved searches`
    : "my enabled saved searches";
  return hostRequest(
    `Use the latest installed Goodfinds marketplace-shopping skill to check ${scope} in native background subagents. Read references/background-work.md and get_goodfinds_search_context. ${runIds.length ? `Use saved run IDs ${JSON.stringify(runIds)}.` : "Start or resume a saved run for each search."} Process searches sequentially with at most one active collection worker across the workspace. Read execution_queue before dispatch. Reuse an already claimed active worker. Otherwise delegate only the next scoped search; it must receive a successful claim with its worker ID before opening a browser. A requested run without a worker is queued. Close task tabs and finish the current run before starting the next. Keep the saved browser route, latest brief, photo/video capture and required verification. Return promptly after dispatch only when a supported continuation resumes this chat on completion; otherwise wait for completion and deliver the saved results while the worker handles browsing. If delegation is unavailable, record the interruption instead of running the search in this chat.`,
  );
}

export const SEARCH_REQUEST = searchRequest();

export function interviewRequest(brief: string): string {
  return hostRequest(
    `Use Goodfinds's marketplace-shopping skill to set up a new search. My brief: ${brief}. Read the starter definitions and adaptive-interview guidance. Research relevant buying decisions, then adapt the definition and save a draft with discovery research, broad query plan and selected marketplaces. Ask only decisive missing details using ask_goodfinds_search_question with stage setup; optional details can stay no preference. Save the ready brief and show an editable recap. If I asked to find an item now, dispatch a background search through references/background-work.md without another approval question and follow the shared one-search limit and completion rules. Resolve the monitoring choice through references/evaluation-delivery.md: reuse any explicit one-off or recurring-monitoring instruction, otherwise offer one-off versus keep watching after useful results. Create and verify requested monitoring in this buying conversation through the host scheduler and record its receipt in Goodfinds.`,
  );
}

export async function sendUserRequest(
  app: Pick<App, "getHostCapabilities" | "sendMessage">,
  request: string,
): Promise<SearchRequestResult> {
  requireMessageHost(app);
  const result = await app.sendMessage({
    role: "user",
    content: [{ type: "text", text: hostRequest(request) }],
  });
  if (result.isError) throw new Error("The chat could not accept the request. Try again.");
  return "sent";
}

export async function sendSearchRequest(
  app: Pick<App, "getHostCapabilities" | "sendMessage">,
  searchId?: string,
  runIds: string[] = [],
): Promise<SearchRequestResult> {
  requireMessageHost(app);
  const result = await app.sendMessage({
    role: "user",
    content: [{ type: "text", text: searchRequest(searchId, runIds) }],
  });
  if (result.isError) throw new Error("The chat could not accept the search request. Try again.");
  return "sent";
}
