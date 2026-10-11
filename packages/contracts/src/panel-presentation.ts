import { z } from "zod";

// Presentation is scoped to an opening tool result, never durable workspace state.
export const panelPresentationSchema = z.object({ search_id: z.string().min(1) });
export type PanelPresentation = z.infer<typeof panelPresentationSchema>;

export function panelPresentationForTool(name: string, input: Record<string, unknown>) {
  const request = z.object({ search_id: z.string() }).safeParse(input["request"]);
  const searchId =
    name === "start_goodfinds_search" && request.success
      ? request.data.search_id
      : name === "open_goodfinds_panel"
        ? input["search_id"]
        : undefined;
  const result = panelPresentationSchema.safeParse({ search_id: searchId });
  return result.success ? { goodfinds_panel: result.data } : {};
}
