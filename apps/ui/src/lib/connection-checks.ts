import type { App } from "@modelcontextprotocol/ext-apps";
import { z } from "zod";
import { connectionCheckResultSchema } from "@goodfinds/contracts/connection-checks";
import type { ConnectionCheckRun } from "@goodfinds/contracts/connection-checks";
import { requireMessageHost, sendUserRequest } from "./search";

type ToolCall = (name: string, args: Record<string, unknown>) => Promise<unknown>;
async function checkTool(call: ToolCall, name: string, args: Record<string, unknown>) {
  const raw = z
    .object({
      isError: z.boolean().optional(),
      structuredContent: connectionCheckResultSchema.optional(),
    })
    .parse(await call(name, args));
  if (raw.isError || !raw.structuredContent)
    throw new Error("Couldn't update the check. Read its progress and try again.");
  return raw.structuredContent;
}

export function connectionCheckRequest(run: ConnectionCheckRun): string {
  return `Use the latest installed Goodfinds marketplace-shopping skill's references/background-work.md#connection-checks. Check only the saved connection check ${JSON.stringify({ run_id: run.id, context_id: run.context_id, targets: run.targets })}. Read get_goodfinds_connection_check first. Reuse an already claimed worker; otherwise dispatch a native background subagent using the returned execution launch settings. The subagent must claim this exact check with its actual native identity before browser work, renew its lease, verify the selected routes and save paired observations using complete_goodfinds_connection_check. Return promptly after dispatch so this chat stays available; leave browsing and polling to the child. If delegation is unavailable or launch fails, use interrupt_goodfinds_connection_check on the unclaimed queued check with its current version and the actual reason. Do not browse in the main chat as a fallback. Do not launch a separate CLI/app-server, create a user-owned chat, switch browsers, sign in, change permissions, collect listings or contact sellers.`;
}

/** Queue first, then ask the host agent to dispatch; never launch a runtime here. */
export async function requestConnectionCheck(
  app: Pick<App, "getHostCapabilities" | "sendMessage">,
  call: ToolCall,
  args: Record<string, unknown>,
) {
  requireMessageHost(app);
  const result = await checkTool(call, "start_goodfinds_connection_check", args);
  if (result.run?.status !== "queued") return result;
  try {
    await sendUserRequest(app, connectionCheckRequest(result.run));
    return result;
  } catch {
    // A rejected/timed-out message may have raced a successful worker claim.
    // Stop only an unclaimed check; never overwrite running or terminal work.
    const latest = await checkTool(call, "get_goodfinds_connection_check", {
      mode: args["mode"],
      run_id: result.run.id,
    });
    if (latest.run?.status !== "queued") return latest;
    try {
      return await checkTool(call, "interrupt_goodfinds_connection_check", {
        mode: args["mode"],
        run_id: latest.run.id,
        expected_version: latest.run.version,
        status: "unavailable",
        reason: "Couldn't request a background check from this chat. Try again.",
      });
    } catch {
      return checkTool(call, "get_goodfinds_connection_check", {
        mode: args["mode"],
        run_id: result.run.id,
      });
    }
  }
}
