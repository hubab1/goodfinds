import { accessAvailable, MARKETPLACES } from "@goodfinds/contracts/integrations";
import type { Marketplace } from "@goodfinds/contracts/integrations";
import type { GoodfindsState } from "@goodfinds/contracts/state";
import type { QuietHours } from "@goodfinds/contracts/search-timing";

export type SettingsPatch = Partial<
  Pick<
    GoodfindsState["config"],
    | "browser_preference"
    | "platforms"
    | "baseline_days"
    | "minimum_peer_listings"
    | "journey_checks_enabled"
  >
> & { quiet_hours?: QuietHours; interval_minutes?: number };

export function marketplaceBrowser(state: GoodfindsState, marketplace: Marketplace) {
  const preference = state.config.platforms[marketplace]?.browser ?? "default";
  return preference === "default" ? state.config.browser_preference : preference;
}

export function marketplaceConnection(
  state: GoodfindsState,
  marketplace: Marketplace,
  now: number,
): "Off" | "Not checked" | "Check needed" | "Signed in" | "Sign in" | "Unavailable" {
  if (state.config.platforms[marketplace]?.enabled === false) return "Off";
  const browser = marketplaceBrowser(state, marketplace);
  const access = state.config.browser_access.find(
    (report) => report.browser === browser && report.context_id === state.access_context,
  );
  if (!access) return "Not checked";
  if (
    browser === "external" &&
    state.device_browser &&
    access.browser_id !== state.device_browser.id
  )
    return "Check needed";
  const fresh = (checked: string) =>
    now >= Date.parse(checked) && now - Date.parse(checked) <= 30 * 60_000;
  if (!fresh(access.checked_at)) return "Check needed";
  if (access.status === "denied" || access.status === "unavailable") return "Unavailable";
  const platform = MARKETPLACES.find((item) => item.id === marketplace);
  const domain = platform ? new URL(platform.home).hostname : undefined;
  if (!accessAvailable(state.config.browser_access, browser, state.access_context, now, domain))
    return access.status === "available" ? "Unavailable" : "Check needed";
  const session = state.config.platform_sessions.findLast(
    (item) =>
      item.marketplace === marketplace &&
      item.browser === browser &&
      item.context_id === state.access_context &&
      item.host === access.host &&
      item.profile === access.profile &&
      item.browser_id === access.browser_id,
  );
  if (!session) return "Not checked";
  if (!fresh(session.checked_at)) return "Check needed";
  if (session.status === "signed_in") return "Signed in";
  if (session.status === "signed_out" || session.status === "expired") return "Sign in";
  return "Not checked";
}

export function deviceBrowserLabel(state: GoodfindsState): string {
  const name = state.device_browser?.name.replace(/^Google\s+/u, "");
  return name ? `Default browser (${name})` : "Default browser";
}
