import { z } from "zod";

// Presentation is scoped to an opening tool result, never durable workspace state.
export const panelPresentationSchema = z
  .object({
    search_id: z.string().min(1).optional(),
    listing_key: z.string().min(1).optional(),
    view: z.enum(["searches", "listings"]).optional(),
    mode: z.enum(["live", "sample"]).optional(),
  })
  .refine((target) => Boolean(target.search_id || target.listing_key || target.view));
export type PanelPresentation = z.infer<typeof panelPresentationSchema>;

export function panelPresentationForTool(name: string, input: Record<string, unknown>) {
  const request = z.object({ search_id: z.string() }).safeParse(input["request"]);
  const searchId =
    name === "start_goodfinds_search" && request.success
      ? request.data.search_id
      : ["open_goodfinds_panel", "open_goodfinds_home"].includes(name)
        ? input["search_id"]
        : undefined;
  const result = panelPresentationSchema.safeParse({
    search_id: searchId,
    ...(["open_goodfinds_panel", "open_goodfinds_home"].includes(name)
      ? {
          listing_key: input["listing_key"],
          ...(!searchId ? { view: name === "open_goodfinds_home" ? "searches" : "listings" } : {}),
        }
      : {}),
  });
  return result.success ? { goodfinds_panel: result.data } : {};
}

const hasControlCharacter = (value: string) => /\p{Cc}/u.test(value);

// Host paths are data, never URLs to fetch or actions to execute.
export function parsePanelPath(value: string): PanelPresentation | undefined {
  if (!value.startsWith("/") || value.startsWith("//") || /[#\\\s]/u.test(value)) return undefined;
  const [pathname, query = "", extra] = value.split("?");
  if (extra !== undefined) return undefined;
  const params = new URLSearchParams(query);
  if (
    [...params.keys()].some(
      (key) => !["mode", "search_id"].includes(key) || params.getAll(key).length !== 1,
    )
  )
    return undefined;
  const mode = params.get("mode") ?? "live";
  if (mode !== "live" && mode !== "sample") return undefined;
  const parts = pathname?.split("/").slice(1) ?? [];
  if (parts.length === 1 && ["", "searches", "listings"].includes(parts[0] ?? "")) {
    if (params.has("search_id")) return undefined;
    return { view: parts[0] === "listings" ? "listings" : "searches", mode };
  }
  if (parts.length !== 2 || !["searches", "listings"].includes(parts[0] ?? "")) return undefined;
  try {
    const id = decodeURIComponent(parts[1] ?? "");
    if (!id || id.length > 512 || [".", ".."].includes(id) || hasControlCharacter(id))
      return undefined;
    if (parts[0] === "searches")
      return params.has("search_id") ? undefined : { search_id: id, mode };
    const search = params.get("search_id");
    if (search !== null && (!search || search.length > 512 || hasControlCharacter(search)))
      return undefined;
    return { listing_key: id, ...(search ? { search_id: search } : {}), mode };
  } catch {
    return undefined;
  }
}

export function panelPath(target: PanelPresentation): string {
  const path = target.listing_key
    ? `/listings/${encodeURIComponent(target.listing_key)}`
    : target.search_id
      ? `/searches/${encodeURIComponent(target.search_id)}`
      : target.view === "listings"
        ? "/listings"
        : "/";
  const query = new URLSearchParams();
  if (target.mode === "sample") query.set("mode", "sample");
  if (target.listing_key && target.search_id) query.set("search_id", target.search_id);
  return `${path}${query.size ? `?${query}` : ""}`;
}

export function panelDeepLink(
  target: PanelPresentation,
  installation: {
    pluginId: string;
    marketplace?: string;
    scheme?: "codex" | "chatgpt";
  },
): string {
  const plugin = encodeURIComponent(installation.pluginId);
  const marketplace = installation.marketplace
    ? `@${encodeURIComponent(installation.marketplace)}`
    : "";
  return `${installation.scheme ?? "codex"}://plugins/${plugin}${marketplace}/app/open_goodfinds_home?path=${encodeURIComponent(panelPath(target))}`;
}
