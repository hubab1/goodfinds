import type { Listing } from "@goodfinds/contracts/state";

export function listingContext(listing: Listing, mode: "live" | "sample", searchId?: string) {
  return {
    mode,
    selected_listing: {
      listing_key: listing.key,
      search_id: searchId ?? null,
      title: listing.title,
      url: listing.url ?? null,
      price_minor: listing.price_minor ?? null,
      currency: listing.currency ?? null,
      price_period: listing.price_period ?? null,
      observed_at: listing.observed_at ?? null,
    },
    detail_tool: "get_goodfinds_listing",
  };
}

// Serialize host updates so a slow request cannot restore an already closed listing.
// Only the current owner may clear context; a replaced dialog's cleanup is harmless.
export function createSelectionPublisher(
  send: (context: Record<string, unknown>) => Promise<void>,
) {
  let owner: object | undefined;
  let pending: Record<string, unknown> | undefined;
  let sending = false;
  let lastSent: string | undefined;
  async function drain() {
    if (sending) return;
    sending = true;
    try {
      while (pending) {
        const value = pending;
        pending = undefined;
        const serialized = JSON.stringify(value);
        if (serialized === lastSent) continue;
        try {
          // eslint-disable-next-line no-await-in-loop -- Host context writes must remain ordered.
          await send(value);
          lastSent = serialized;
        } catch {
          // Context is optional. A later selection can retry after host recovery.
          lastSent = undefined;
        }
      }
    } finally {
      sending = false;
    }
  }
  function enqueue(context: Record<string, unknown>) {
    pending = context;
    void drain();
  }
  return (context: Record<string, unknown>) => {
    const token = {};
    owner = token;
    enqueue(context);
    return () => {
      if (owner !== token) return;
      owner = undefined;
      enqueue({ selected_listing: null });
    };
  };
}
