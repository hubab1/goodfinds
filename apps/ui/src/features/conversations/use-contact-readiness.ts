import { useEffect, useState } from "react";
import type { Listing, GoodfindsState } from "@goodfinds/contracts/state";
import { listingContactState } from "@goodfinds/contracts/marketplace-actions";

export function contactReadiness(listing: Listing, state: GoodfindsState) {
  return listingContactState(listing, {
    config: state.config,
    context_id: state.access_context,
    now: Date.now(),
    mode: state.mode,
  });
}
export function useContactReadiness(listing: Listing, state: GoodfindsState) {
  const [expiry, refresh] = useState(0);
  const readiness = contactReadiness(listing, state);
  const observation = readiness.observation;
  useEffect(() => {
    if (!observation) return undefined;
    const reports = [
      observation,
      ...state.config.browser_access.filter(
        (r) =>
          r.browser === observation.browser &&
          r.host === observation.host &&
          r.profile === observation.profile,
      ),
      ...state.config.platform_sessions.filter(
        (r) =>
          r.marketplace === observation.marketplace &&
          r.browser === observation.browser &&
          r.host === observation.host &&
          r.profile === observation.profile,
      ),
    ];
    const expiries = reports
      .map((r) => Date.parse(r.checked_at) + 30 * 60_000 - Date.now())
      .filter((delay) => delay > 0);
    if (!expiries.length) return undefined;
    const timer = setTimeout(() => refresh(expiry + 1), Math.min(...expiries) + 10);
    return () => clearTimeout(timer);
  }, [state, observation, expiry]);
  return readiness;
}
