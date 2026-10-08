import { z } from "zod";

export const listingDiscoverySchema = z
  .object({
    search_id: z.string(),
    run_id: z.uuid(),
    run_started_at: z.iso.datetime(),
    recorded_at: z.iso.datetime().nullable(),
  })
  .strict();
export type ListingDiscovery = z.infer<typeof listingDiscoverySchema>;

export function firstDiscovery(
  discoveries: ListingDiscovery[],
  searchId?: string,
): ListingDiscovery | undefined {
  let first: ListingDiscovery | undefined;
  for (const discovery of discoveries) {
    if (searchId && discovery.search_id !== searchId) continue;
    if (!first || Date.parse(discovery.run_started_at) < Date.parse(first.run_started_at))
      first = discovery;
  }
  return first;
}
