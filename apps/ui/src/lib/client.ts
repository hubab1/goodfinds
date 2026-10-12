import {
  workspaceResetPreviewSchema,
  workspaceResetResultSchema,
} from "@goodfinds/contracts/workspace-reset";
import { searchRunSchema } from "@goodfinds/contracts/search-workflow";
import type { PanelTool, PanelInput } from "./actions";
import { searchRunAction, sellerAction } from "@goodfinds/contracts/tool-names";
import { GOODFINDS_VERSION } from "@goodfinds/contracts/version";
import { locationPageResultSchema } from "@goodfinds/contracts/external-tools";
import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
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
import { feedbackEventSchema } from "@goodfinds/contracts/discovery";
import { panelPresentationSchema, parsePanelPath } from "@goodfinds/contracts/panel-presentation";
import type { PanelPresentation } from "@goodfinds/contracts/panel-presentation";
import { createSelectionPublisher } from "./selection-context";

declare global {
  interface Window {
    __GOODFINDS_PREVIEW__?: {
      token: string;
      locationOnly?: boolean;
      workspaceMode?: "live" | "sample";
    };
  }
}

const listeners = new Set<(state: GoodfindsState, presentation?: PanelPresentation) => void>();
let connection: Promise<App> | undefined;
let latestState: GoodfindsState | undefined;
let pendingPresentation: PanelPresentation | undefined;
let openingInputId: string | undefined;
let openingInputApplied = false;
let deepLinkMode: "live" | "sample" | undefined;
let initialDeepLink = false;
const targetIdentity = (target: PanelPresentation) =>
  JSON.stringify([target.search_id, target.listing_key]);
function presentPending(state: GoodfindsState) {
  const target = pendingPresentation;
  if (!target || (target.mode && target.mode !== state.mode)) return false;
  pendingPresentation = undefined;
  if (targetIdentity(target) === openingInputId) openingInputApplied = true;
  for (const listener of listeners) listener(state, target);
  return true;
}
const revisionsBySnapshot = new Map<string, Revisions>();
function remember(state: GoodfindsState) {
  if (deepLinkMode && state.mode !== deepLinkMode) return state;
  if (
    latestState &&
    (latestState.mode !== state.mode || (!state.searches.length && !state.listings.length))
  )
    getSavedImage.clear();
  latestState = state;
  presentPending(state);
  revisionsBySnapshot.set(state.revision, state.revisions);
  if (revisionsBySnapshot.size > 100) {
    const oldest = revisionsBySnapshot.keys().next().value;
    if (oldest) revisionsBySnapshot.delete(oldest);
  }
  return state;
}

function connect(): Promise<App> {
  connection ??= (async () => {
    let receivedToolResult = false;
    const app = new App(
      { name: "Goodfinds", version: GOODFINDS_VERSION },
      { availableDisplayModes: ["inline", "fullscreen"] },
      { autoResize: true },
    );
    const deepLink = (context: Record<string, unknown> | undefined) => {
      const value = z.object({ url: z.string() }).safeParse(context?.["openai/deepLink"]);
      if (!value.success) return;
      const target = parsePanelPath(value.data.url);
      if (!target) return;
      deepLinkMode = target.mode ?? "live";
      initialDeepLink = !receivedToolResult;
      pendingPresentation = target;
      if (latestState && presentPending(latestState)) return;
      // Initial links may arrive before the fallback workspace read or target another mode.
      void invoke("get_goodfinds_workspace", { mode: target.mode ?? "live" }).catch(() => {});
    };
    app.addEventListener("hostcontextchanged", (context) => {
      const { theme } = context;
      if (theme) applyDocumentTheme(theme);
      if ("openai/deepLink" in context) deepLink(context);
    });
    app.addEventListener("toolinput", ({ arguments: input }) => {
      if (initialDeepLink) return;
      if (receivedToolResult) deepLinkMode = undefined;
      const args = z
        .object({
          search_id: z.string().optional(),
          listing_key: z.string().optional(),
          request: z.object({ search_id: z.string() }).optional(),
        })
        .safeParse(input);
      const target = panelPresentationSchema.safeParse({
        search_id: args.success ? (args.data.search_id ?? args.data.request?.search_id) : undefined,
        listing_key: args.success ? args.data.listing_key : undefined,
      });
      if (!target.success) return;
      deepLinkMode = undefined;
      initialDeepLink = false;
      openingInputId = targetIdentity(target.data);
      openingInputApplied = false;
      pendingPresentation = target.data;
      if (latestState) presentPending(latestState);
    });
    app.addEventListener("toolresult", (result) => {
      receivedToolResult = true;
      const parsed = (() => {
        try {
          return stateFromToolResult(result);
        } catch {
          return undefined;
        }
      })();
      const presentation = panelPresentationSchema.safeParse(result._meta?.["goodfinds_panel"]);
      if (presentation.success && !initialDeepLink) deepLinkMode = undefined;
      if (
        presentation.success &&
        !initialDeepLink &&
        !(openingInputApplied && targetIdentity(presentation.data) === openingInputId)
      )
        pendingPresentation = presentation.data;
      openingInputId = undefined;
      openingInputApplied = false;
      initialDeepLink = false;
      if (parsed && (!deepLinkMode || parsed.mode === deepLinkMode)) {
        const target = pendingPresentation;
        remember(parsed);
        if (target === pendingPresentation) for (const listener of listeners) listener(parsed);
      } else if (latestState) presentPending(latestState);
    });
    await app.connect();
    const theme = app.getHostContext()?.theme;
    if (theme) applyDocumentTheme(theme);
    deepLink(app.getHostContext());
    return app;
  })().catch((error: unknown) => {
    connection = undefined;
    throw error;
  });
  return connection;
}

export async function readInitialWorkspace(): Promise<GoodfindsState> {
  if (!window.__GOODFINDS_PREVIEW__) await connect();
  const state = await invoke("get_goodfinds_workspace", { mode: deepLinkMode ?? "live" });
  return deepLinkMode && state.mode !== deepLinkMode ? readInitialWorkspace() : state;
}

export const publishListingContext = createSelectionPublisher(async (context) => {
  if (window.__GOODFINDS_PREVIEW__) return;
  const app = await connect();
  if (!app.getHostCapabilities()?.updateModelContext?.structuredContent) return;
  await app.updateModelContext({ structuredContent: { goodfinds: context } });
});

export function subscribeToState(
  listener: (state: GoodfindsState, presentation?: PanelPresentation) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const preview = window.__GOODFINDS_PREVIEW__;
  if (preview) {
    const response = await fetch("/api/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goodfinds-Token": preview.token },
      body: JSON.stringify({ name, arguments: args }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok)
      throw new Error("Could not connect to Goodfinds. Refresh the panel and try again.");
    const result: unknown = await response.json();
    return result;
  }
  const app = await connect();
  return app.callServerTool({ name, arguments: args }, signal ? { signal } : undefined);
}

// Feedback retries need the receipt's exact event, not the last event in a fresh snapshot.
export async function invokeFeedback(
  name: "record_goodfinds_listing_feedback" | "undo_goodfinds_listing_feedback",
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  const result = await callTool(name, args, signal);
  const state = remember(stateFromToolResult(result));
  const { structuredContent } = z
    .object({ structuredContent: z.object({ feedback: feedbackEventSchema }) })
    .parse(result);
  return { state, feedback: structuredContent.feedback };
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
  if (
    deepLinkMode &&
    name === "get_goodfinds_workspace" &&
    args["mode"] &&
    args["mode"] !== deepLinkMode
  ) {
    deepLinkMode = undefined;
    pendingPresentation = undefined;
  }
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
  const result = await callTool(name, {
    ...Object.fromEntries(Object.entries(args).filter(([key]) => key !== "snapshot_revision")),
    ...scoped,
    ...(operation &&
    !operation.startsWith("get_") &&
    sellerAction(operation) === undefined &&
    searchRunAction(operation) === undefined &&
    operation !== "load_sample_workspace"
      ? { request_id: args["request_id"] ?? crypto.randomUUID() }
      : {}),
  });
  const state = remember(stateFromToolResult(result));
  if (name === "reset_goodfinds_workspace") {
    const reset = z
      .object({ structuredContent: z.object({ reset: workspaceResetResultSchema }) })
      .parse(result).structuredContent.reset;
    if (!reset.media_cleanup_complete)
      throw new Error(
        "Data was deleted, but cached-file cleanup is incomplete. Retry with the same request ID.",
      );
  }
  return state;
}
export async function previewWorkspaceReset(mode: "live" | "sample") {
  const raw = await callTool("preview_goodfinds_workspace_reset", { mode });
  return z.object({ structuredContent: workspaceResetPreviewSchema }).parse(raw).structuredContent;
}

const imageResultSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(
    z.union([
      z.object({
        type: z.literal("image"),
        mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/avif"]),
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
        search_runs: z.array(
          z.object({
            id: z.string(),
            version: z.number(),
            refresh_key: z.string().optional(),
            updated_at: z.iso.datetime().optional(),
            worker: searchRunSchema.shape.worker.optional(),
          }),
        ),
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
