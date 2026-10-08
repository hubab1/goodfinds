import { useCallback, useEffect, useEffectEvent, useRef } from "react";
import type { ListingSeenInput } from "@goodfinds/contracts/listing-reading";
import type { GoodfindsState } from "@goodfinds/contracts/state";
import { listingSearchIds, unseenSearchIds } from "@goodfinds/contracts/listing-reading";
import { selectListings, EMPTY_SELLER_FILTERS } from "@goodfinds/contracts/listing-query";
import { invoke } from "@/lib/client";
import { observeListingVisibility } from "@/lib/listing-visibility";

type Pair = ListingSeenInput["listings"][number];
export type RecordSeen = (pairs: Pair[]) => Promise<boolean>;

export function mergeSeen(
  current: GoodfindsState,
  next: GoodfindsState,
  pairs: Pair[],
): GoodfindsState {
  if (current.mode !== next.mode) return current;
  const listings = current.listings.map((listing) => {
    const updated = next.listings.find((item) => item.key === listing.key);
    const searches = new Set(
      pairs.filter((pair) => pair.listing_key === listing.key).map((pair) => pair.search_id),
    );
    if (!searches.size || !updated) return listing;
    return {
      ...listing,
      seen_in_searches: [
        ...(listing.seen_in_searches ?? []).filter((item) => !searches.has(item.search_id)),
        ...(updated.seen_in_searches ?? []).filter((item) => searches.has(item.search_id)),
      ],
    };
  });
  const updated = { ...current, listings };
  return {
    ...updated,
    searches: current.searches.map((search) => {
      const related = selectListings(updated, {
        search_id: search.id,
        sellerFilters: EMPTY_SELLER_FILTERS,
      }).filter((listing) => listingSearchIds(listing, [search]).length > 0);
      const unseen_count = related.filter(
        (listing) => unseenSearchIds(listing, [search]).length > 0,
      ).length;
      return { ...search, unseen_count, seen_count: related.length - unseen_count };
    }),
  };
}

export function createSeenRecorder(save: (pairs: Pair[]) => Promise<void>): {
  record: RecordSeen;
  dispose: () => void;
} {
  const pending = new Map<
    string,
    { pair: Pair; promise: Promise<boolean>; resolve: (success: boolean) => void }
  >();
  let disposed = false;
  let saving = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function flush() {
    timer = undefined;
    if (disposed || saving) return;
    saving = true;
    const batch = [...pending.entries()].slice(0, 200);
    let success = false;
    try {
      await save(batch.map(([, entry]) => entry.pair));
      success = true;
    } catch {
      /* Cards retry while visible; a read receipt never blocks interaction. */
    }
    for (const [key, entry] of batch) {
      pending.delete(key);
      entry.resolve(success);
    }
    saving = false;
    if (!disposed && pending.size)
      timer = setTimeout(() => {
        void flush();
      }, 200);
  }
  return {
    record: (pairs) => {
      if (disposed || !pairs.length) return Promise.resolve(false);
      const promises = pairs.map((pair) => {
        const key = JSON.stringify([pair.search_id, pair.listing_key]);
        const existing = pending.get(key);
        if (existing) return existing.promise;
        let resolve!: (success: boolean) => void;
        const promise = new Promise<boolean>((done) => {
          resolve = done;
        });
        pending.set(key, { pair, promise, resolve });
        return promise;
      });
      if (!timer && !saving)
        timer = setTimeout(() => {
          void flush();
        }, 200);
      return Promise.all(promises).then((results) => results.every(Boolean));
    },
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
      for (const entry of pending.values()) entry.resolve(false);
      pending.clear();
    },
  };
}

export function useSeenRecorder(
  mode: GoodfindsState["mode"],
  update: (next: GoodfindsState, pairs: Pair[]) => void,
) {
  const merge = useEffectEvent(update);
  const recorder = useRef<
    { mode: GoodfindsState["mode"]; value: ReturnType<typeof createSeenRecorder> } | undefined
  >(undefined);
  useEffect(() => {
    let active = true;
    const current = createSeenRecorder(async (pairs) => {
      const next = await invoke("set_goodfinds_listing_seen", {
        mode,
        listings: pairs,
        seen: true,
      });
      if (active) merge(next, pairs);
    });
    recorder.current = { mode, value: current };
    return () => {
      active = false;
      current.dispose();
    };
  }, [mode]);
  return useCallback(
    (pairs: Pair[]) =>
      recorder.current?.mode === mode
        ? recorder.current.value.record(pairs)
        : Promise.resolve(false),
    [mode],
  );
}

export function useListingExposure(key: string, searchIds: string[], onSeen?: RecordSeen) {
  const ref = useRef<HTMLElement>(null);
  const ids = JSON.stringify(searchIds);
  const enabled = Boolean(onSeen);
  const save = useEffectEvent(
    () =>
      onSeen?.(searchIds.map((search_id) => ({ search_id, listing_key: key }))) ??
      Promise.resolve(false),
  );
  useEffect(() => {
    if (!enabled || ids === "[]" || !ref.current || typeof IntersectionObserver === "undefined")
      return undefined;
    ref.current.dataset["readingListing"] = key;
    return observeListingVisibility(ref.current, () => save());
  }, [key, ids, enabled]);
  return ref;
}
