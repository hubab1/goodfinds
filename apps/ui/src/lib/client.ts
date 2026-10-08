import type { PanelTool, PanelInput } from "./actions";
import { searchRunAction, sellerAction } from "@goodfinds/contracts/tool-names";
import { GOODFINDS_VERSION } from "@goodfinds/contracts/version";
import { locationPageResultSchema } from "@goodfinds/contracts/external-tools";
import { App } from "@modelcontextprotocol/ext-apps";
import { entityRevision, entityTarget } from "@goodfinds/contracts/revisions";
import type { Revisions } from "@goodfinds/contracts/revisions";
import { operationForTool } from "@goodfinds/contracts/tool-names";
import { stateFromToolResult } from "@goodfinds/contracts/state";
import type { GoodfindsState } from "@goodfinds/contracts/state";
import {
  AUTOMATION_UNAVAILABLE,
  interviewRequest,
  requireMessageHost,
  sendSearchRequest,
  sendUserRequest,
} from "./search";
import type { SearchRequestResult } from "./search";
import { z } from "zod";
import { monitoringSummarySchema } from "@goodfinds/contracts/monitoring";
import { connectionCheckResultSchema } from "@goodfinds/contracts/connection-checks";
import type { Marketplace } from "@goodfinds/contracts/integrations";
import { createImageLoader } from "./image-loader";
import { requestConnectionCheck } from "./connection-checks";

declare global {
  interface Window {
    __GOODFINDS_PREVIEW__?: {
      token: string;
      locationOnly?: boolean;
      workspaceMode?: "live" | "sample";
    };
  }
}

const listeners = new Set<(state: GoodfindsState) => void>();
let connection: Promise<App> | undefined;
const revisionsBySnapshot = new Map<string, Revisions>();
function remember(state: GoodfindsState) {
  revisionsBySnapshot.set(state.revision, state.revisions);
  if (revisionsBySnapshot.size > 100) {
    const oldest = revisionsBySnapshot.keys().next().value;
    if (oldest) revisionsBySnapshot.delete(oldest);
  }
  return state;
}

function connect(): Promise<App> {
  connection ??= (async () => {
    const app = new App(
      { name: "Goodfinds", version: GOODFINDS_VERSION },
      {},
      { autoResize: true },
    );
    app.addEventListener("toolresult", (result) => {
      const parsed = (() => {
        try {
          return stateFromToolResult(result);
        } catch {
          return undefined;
        }
      })();
      if (parsed) remember(parsed);
      if (parsed) for (const listener of listeners) listener(parsed);
    });
    await app.connect();
    return app;
  })().catch((error: unknown) => {
    connection = undefined;
    throw error;
  });
  return connection;
}

export function subscribeToState(listener: (state: GoodfindsState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const preview = window.__GOODFINDS_PREVIEW__;
  if (preview) {
    const response = await fetch("/api/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goodfinds-Token": preview.token },
      body: JSON.stringify({ name, arguments: args }),
    });
    if (!response.ok)
      throw new Error("Could not connect to Goodfinds. Refresh the panel and try again.");
    const result: unknown = await response.json();
    return result;
  }
  const app = await connect();
  return app.callServerTool({ name, arguments: args });
}

export async function openLocationBrowser(mode: "live" | "sample"): Promise<void> {
  // Preserve the click's browser gesture while the one-use page is created.
  const preview = Boolean(window.__GOODFINDS_PREVIEW__);
  const page = preview ? window.open("about:blank", "_blank") : null;
  if (preview && !page) throw new Error("Allow a new tab, then try again.");
  if (page) page.opener = null;
  try {
    const raw = await callTool("open_goodfinds_location_chooser", { mode });
    const result = z
      .object({
        isError: z.boolean().optional(),
        structuredContent: locationPageResultSchema,
      })
      .parse(raw);
    if (result.isError) throw new Error("Could not open location. Try again.");
    const url = new URL(result.structuredContent.result.url);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname))
      throw new Error("Could not open location. Try again.");
    if (page) page.location.replace(url.href);
    else {
      const app = await connect();
      const opened = await app.openLink({ url: url.href });
      if (opened.isError) throw new Error("Could not open location. Try again.");
    }
  } catch (error) {
    page?.close();
    throw error;
  }
}

export function invoke<K extends PanelTool>(name: K, args: PanelInput<K>): Promise<GoodfindsState>;
export async function invoke(name: string, args: Record<string, unknown>): Promise<GoodfindsState> {
  const operation = operationForTool(name);
  const revisions =
    typeof args["snapshot_revision"] === "string"
      ? revisionsBySnapshot.get(args["snapshot_revision"])
      : undefined;
  const target = operation ? entityTarget(operation, args) : undefined;
  const scoped =
    revisions && target
      ? {
          expected_entity_revision: entityRevision(revisions, target),
          ...(typeof args["draft_id"] === "string"
            ? { expected_draft_revision: revisions.drafts[args["draft_id"]] ?? revisions.absent }
            : {}),
        }
      : {};
  return remember(
    stateFromToolResult(
      await callTool(name, {
        ...Object.fromEntries(Object.entries(args).filter(([key]) => key !== "snapshot_revision")),
        ...scoped,
        ...(operation &&
        !operation.startsWith("get_") &&
        sellerAction(operation) === undefined &&
        searchRunAction(operation) === undefined &&
        operation !== "load_sample_workspace"
          ? { request_id: args["request_id"] ?? crypto.randomUUID() }
          : {}),
      }),
    ),
  );
}

const imageResultSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(
    z.union([
      z.object({
        type: z.literal("image"),
        mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
        data: z
          .string()
          .regex(/^[A-Za-z0-9+/=]+$/)
          .max(14_000_000),
      }),
      z.object({ type: z.literal("text"), text: z.string() }),
    ]),
  ),
});
export const getSavedImage = createImageLoader(async (mediaId) => {
  const result = imageResultSchema.parse(
    await callTool("get_goodfinds_image", { media_id: mediaId }),
  );
  const image = result.content.find((content) => content.type === "image");
  if (result.isError || !image) throw new Error("Saved image unavailable");
  return `data:${image.mimeType};base64,${image.data}`;
});

export async function getSavedVideo(mediaId: string): Promise<string> {
  const result = z
    .object({
      isError: z.boolean().optional(),
      structuredContent: z
        .object({
          mime_type: z.enum(["video/mp4", "video/webm"]),
          data: z
            .string()
            .regex(/^[A-Za-z0-9+/=]+$/)
            .max(67_000_000),
        })
        .optional(),
    })
    .parse(await callTool("get_goodfinds_video", { media_id: mediaId }));
  if (result.isError || !result.structuredContent) throw new Error("Saved video unavailable");
  const video = result.structuredContent;
  return `data:${video.mime_type};base64,${video.data}`;
}

export async function readSearchRuns(mode: "live" | "sample") {
  const result = z
    .object({
      isError: z.boolean().optional(),
      structuredContent: z.object({
        search_runs: z.array(z.object({ id: z.string(), version: z.number() })),
      }),
    })
    .parse(await callTool("list_goodfinds_search_runs", { mode, progress_only: true }));
  if (result.isError) throw new Error("Search progress is unavailable");
  return result.structuredContent.search_runs;
}
export async function readMonitoring(mode: "live" | "sample") {
  const result = z
    .object({
      isError: z.boolean().optional(),
      structuredContent: z.object({
        revision: z.string(),
        monitoring: z.array(monitoringSummarySchema),
      }),
    })
    .parse(await callTool("get_goodfinds_monitoring", { mode }));
  if (result.isError) throw new Error("Schedule status is unavailable");
  return result.structuredContent;
}

async function connectionCheckTool(name: string, args: Record<string, unknown>) {
  const raw = await callTool(name, args);
  const result = z
    .object({
      isError: z.boolean().optional(),
      structuredContent: connectionCheckResultSchema.optional(),
    })
    .parse(raw);
  if (result.isError || !result.structuredContent)
    throw new Error("Couldn't check connections. Try again.");
  return result.structuredContent;
}

export async function startConnectionCheck(
  mode: "live" | "sample",
  revision: string,
  marketplaces?: Marketplace[],
) {
  return requestConnectionCheck(await requireHostActions(), callTool, {
    mode,
    expected_entity_revision: revision,
    request_id: crypto.randomUUID(),
    ...(marketplaces ? { marketplaces } : {}),
  });
}

export function readConnectionCheck(mode: "live" | "sample", runId?: string) {
  return connectionCheckTool("get_goodfinds_connection_check", {
    mode,
    ...(runId ? { run_id: runId } : {}),
  });
}

export function cancelConnectionCheck(mode: "live" | "sample", runId: string) {
  return connectionCheckTool("cancel_goodfinds_connection_check", { mode, run_id: runId });
}
export async function requestBrowserSearch(
  searchId?: string,
  runIds: string[] = [],
): Promise<SearchRequestResult> {
  return sendSearchRequest(await requireHostActions(), searchId, runIds);
}

export async function requestSearchInterview(brief: string): Promise<SearchRequestResult> {
  return sendUserRequest(await requireHostActions(), interviewRequest(brief));
}

export async function requestHostAction(request: string): Promise<SearchRequestResult> {
  return sendUserRequest(
    await requireHostActions(),
    `${request}\nKeep this chat available: delegate lengthy read-only browser checks to a native background subagent using the latest Goodfinds skill's references/background-work.md, then return after dispatch. Keep schedule changes in this buying chat and preserve every reviewed-send requirement.`,
  );
}

export async function requireHostActions(): Promise<App> {
  if (window.__GOODFINDS_PREVIEW__) throw new Error(AUTOMATION_UNAVAILABLE);
  const app = await connect();
  requireMessageHost(app);
  return app;
}
