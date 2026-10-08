import { z } from "zod";
import { ebaySearchSchema, ebayItemSchema } from "@goodfinds/contracts/external-tools";
import { itemSchema, ebayEvidence } from "../connections/ebay.ts";
export function createEbayClient(
  options: {
    clientId?: string;
    clientSecret?: string;
    fetcher?: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
  } = {},
) {
  const fetcher = options.fetcher ?? fetch;
  const clientId = options.clientId ?? process.env["GOODFINDS_EBAY_CLIENT_ID"],
    clientSecret = options.clientSecret ?? process.env["GOODFINDS_EBAY_CLIENT_SECRET"];
  let cached: { token: string; expires: number } | undefined;
  async function token(signal: AbortSignal): Promise<string> {
    if (!clientId || !clientSecret)
      throw new Error(
        "eBay Browse is not configured. Set GOODFINDS_EBAY_CLIENT_ID and GOODFINDS_EBAY_CLIENT_SECRET on the server; do not paste secrets into chat. Browser search links remain available.",
      );
    if (cached && cached.expires > Date.now()) return cached.token;
    const response = await fetcher("https://api.ebay.com/identity/v1/oauth2/token", {
      method: "POST",
      signal,
      redirect: "error",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "https://api.ebay.com/oauth/api_scope",
      }),
    });
    if (!response.ok)
      throw new Error(
        "eBay application authentication failed. Check the server's production credentials and API access.",
      );
    const raw: unknown = await response.json();
    const data = z
      .object({ access_token: z.string().min(1), expires_in: z.number().positive() })
      .parse(raw);
    cached = {
      token: data.access_token,
      expires: Date.now() + Math.max(0, data.expires_in - 60) * 1000,
    };
    return cached.token;
  }
  async function get(path: string, marketplace: string, signal?: AbortSignal): Promise<unknown> {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000);
    const response = await fetcher(`https://api.ebay.com/buy/browse/v1/${path}`, {
      signal: requestSignal,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${await token(requestSignal)}`,
        "X-EBAY-C-MARKETPLACE-ID": marketplace,
      },
    });
    if (response.status === 401) cached = undefined;
    if (!response.ok)
      throw new Error(
        response.status === 429
          ? "eBay API quota reached. Retry later; this check did not complete."
          : `eBay lookup failed (${response.status}). This check did not complete.`,
      );
    const raw: unknown = await response.json();
    return raw;
  }
  return {
    configured: Boolean(clientId && clientSecret),
    async search(input: unknown, signal?: AbortSignal) {
      const args = ebaySearchSchema.parse(input);
      const params = new URLSearchParams({
        q: args.query,
        limit: String(args.limit),
        offset: String(args.offset),
        filter: "buyingOptions:{FIXED_PRICE}",
        fieldgroups: "EXTENDED",
      });
      const data = z
        .object({
          itemSummaries: z.array(itemSchema).default([]),
          total: z.number().optional(),
          next: z.string().optional(),
        })
        .parse(await get(`item_summary/search?${params}`, args.marketplace, signal));
      return {
        source: "ebay",
        query: args.query,
        marketplace: args.marketplace,
        checked_at: new Date().toISOString(),
        offset: args.offset,
        returned_count: data.itemSummaries.length,
        total: data.total ?? null,
        has_more: Boolean(data.next),
        pagination_complete: !data.next && args.offset === 0,
        items: data.itemSummaries.map(ebayEvidence),
      };
    },
    async item(input: unknown, signal?: AbortSignal) {
      const args = ebayItemSchema.parse(input);
      const evidence = ebayEvidence(
        await get(`item/${encodeURIComponent(args.item_id)}`, args.marketplace, signal),
      );
      if (evidence.item_id !== args.item_id) throw new Error("eBay returned a different item");
      return evidence;
    },
  };
}
