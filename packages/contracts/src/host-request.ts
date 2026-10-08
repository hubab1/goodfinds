import { WORKER_ROUTING_GUIDANCE } from "./worker-execution.ts";

export const QUIET_BROWSING_GUIDANCE =
  "Keep intermediate browsing quiet. Prefer DOM/accessibility text for navigation, listing descriptions and seller/profile checks. Use screenshots only for necessary visual evidence, with documented non-emitting options when inspection remains possible. Do not attach or re-emit intermediate listing/profile screenshots or call emitImage just to show progress. Save useful photos in Goodfinds's panel. Give concise progress and final findings. Review every available shortlisted photo before claiming complete verification; hidden or uninspected images do not establish facts. If the host must display a visual tool result, use the minimum necessary calls and avoid duplicate output.";

export function hostRequest(request: string): string {
  const body = request.endsWith(QUIET_BROWSING_GUIDANCE)
    ? request.slice(0, -QUIET_BROWSING_GUIDANCE.length).trimEnd()
    : request;
  const routed = body.includes(WORKER_ROUTING_GUIDANCE)
    ? body
    : `${body} ${WORKER_ROUTING_GUIDANCE}`;
  return `${routed} ${QUIET_BROWSING_GUIDANCE}`;
}
