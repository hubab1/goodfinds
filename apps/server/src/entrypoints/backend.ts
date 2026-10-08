import type { CommandName, OperationInput, QueryName } from "@goodfinds/contracts/operations";
import type { WorkspaceConfiguration } from "../workspace/model.ts";
import { Context, Effect, Layer, Logger } from "effect";
import type { TransportError } from "../workspace/errors.ts";
import type { mediaFilesSchema } from "../platform/media.ts";
import type { WorkspaceMode } from "@goodfinds/contracts/state";
import { executeWorkspaceCommand, WorkspaceStore } from "../platform/workspace-sqlite.ts";
import {
  cacheImages,
  cacheMedia,
  readImage,
  readVideo,
  readMediaFile,
  validateImageReferences,
} from "../platform/media.ts";
import type { z } from "zod";
import { bundledSearchCoverById } from "@goodfinds/contracts/search-cover-presets";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { SEARCH_COVERS_DIRECTORY, PANEL_HTML_PATH } from "../platform/runtime.ts";
import { transport } from "../workspace/errors.ts";
import { codexAutomationsDirectory } from "../platform/host-schedules.ts";
import { getDeviceBrowser } from "../platform/device-browser.ts";
import type { DeviceBrowser } from "../platform/device-browser.ts";

// One application service owns the workspace and its storage/media adapters. MCP and the
// loopback preview use the same implementation, while tests can supply another Layer.
export class Backend extends Context.Service<
  Backend,
  {
    request: <K extends CommandName>(
      action: K,
      args: OperationInput<K>,
      mode: WorkspaceMode,
      guard?: (config: WorkspaceConfiguration) => void,
    ) => ReturnType<typeof executeWorkspaceCommand>;
    cacheImages: (files: z.infer<typeof mediaFilesSchema>) => ReturnType<typeof cacheImages>;
    cacheMedia: (files: z.infer<typeof mediaFilesSchema>) => ReturnType<typeof cacheMedia>;
    readVideo: (id: string) => ReturnType<typeof readVideo>;
    readMediaFile: (id: string) => ReturnType<typeof readMediaFile>;
    readImage: (id: string) => ReturnType<typeof readImage>;
    validateImages: (observations: unknown) => ReturnType<typeof validateImageReferences>;
    panel: Effect.Effect<string, TransportError>;
    query: (
      action: QueryName,
      args: Parameters<WorkspaceStore["query"]>[1],
      mode: WorkspaceMode,
    ) => ReturnType<WorkspaceStore["query"]>;
  }
>()("goodfinds/Backend") {}

export const backendLayer = (
  workspaceDirectory: string,
  automationsDirectory: string | null = codexAutomationsDirectory(),
  readDeviceBrowser: () => Promise<DeviceBrowser | null> = getDeviceBrowser,
) =>
  Layer.mergeAll(
    Layer.succeed(Backend, {
      request: (action, args, mode, guard) =>
        Effect.all(
          {
            result: executeWorkspaceCommand(
              action,
              args,
              mode,
              workspaceDirectory,
              automationsDirectory,
              guard,
            ),
            browser: Effect.promise(readDeviceBrowser),
          },
          { concurrency: "unbounded" },
        ).pipe(
          Effect.map(({ result, browser }) => {
            result.state.device_browser = browser;
            return result;
          }),
        ),
      query: (action, args, mode) =>
        new WorkspaceStore(workspaceDirectory, mode, automationsDirectory).query(action, args).pipe(
          Effect.flatMap((result) =>
            action === "get_settings"
              ? Effect.map(Effect.promise(readDeviceBrowser), (device_browser) => ({
                  ...result,
                  device_browser,
                }))
              : Effect.succeed(result),
          ),
        ),
      cacheImages: (files) => cacheImages(workspaceDirectory, files),
      cacheMedia: (files) => cacheMedia(workspaceDirectory, files),
      readVideo: (id) => readVideo(workspaceDirectory, id),
      readMediaFile: (id) => readMediaFile(workspaceDirectory, id),
      readImage: (id) => {
        const bundled = bundledSearchCoverById(id);
        return readImage(
          workspaceDirectory,
          id,
          bundled
            ? { path: resolve(SEARCH_COVERS_DIRECTORY, bundled.file), mediaId: bundled.media_id }
            : undefined,
        );
      },
      validateImages: (observations) => validateImageReferences(workspaceDirectory, observations),
      panel: transport((signal) => readFile(PANEL_HTML_PATH, { encoding: "utf8", signal })),
    }),
    Layer.succeed(Logger.LogToStderr, true),
  );
