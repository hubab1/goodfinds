import { z } from "zod";
export const workspaceResetPreviewSchema = z.object({
  mode: z.enum(["live", "sample"]),
  reset_token: z.string(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  media_files: z.number().int().nonnegative(),
  media_bytes: z.number().nonnegative(),
  active_run_ids: z.array(z.uuid()),
  schedule_cleanup: z.array(z.object({ automation_id: z.string(), status: z.string() })),
  ready: z.boolean(),
  scope: z.string(),
});
export type WorkspaceResetPreview = z.infer<typeof workspaceResetPreviewSchema>;
export const workspaceResetResultSchema = z.object({
  deleted_counts: z.record(z.string(), z.number().int().nonnegative()),
  deleted_media_files: z.number().int().nonnegative(),
  media_cleanup_complete: z.boolean(),
});
