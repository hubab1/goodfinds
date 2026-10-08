import { seedWorkspace } from "./helpers/workspace.ts";
import { revisionFor } from "./helpers/revisions.ts";
import { sellerActions } from "@goodfinds/contracts/tool-names";
// These are simulated integration scenarios, not live marketplace acceptance tests.
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Clock, Effect } from "effect";
import { WorkspaceStore } from "../apps/server/src/platform/workspace-sqlite.ts";
import { ListingCard } from "../apps/ui/src/features/listings/listing-card.tsx";
import { ContactOptions } from "../apps/ui/src/features/conversations/contact-options.tsx";
import { BrowserSettings } from "../apps/ui/src/features/settings/browser-settings.tsx";
import {
  listingContactState,
  listingContactReportSchema,
  sellerApproach,
  validatePlatformOffer,
} from "@goodfinds/contracts/marketplace-actions";
import { marketplaceSchema } from "@goodfinds/contracts/integrations";
import type { Marketplace } from "@goodfinds/contracts/integrations";
import type { GoodfindsState } from "@goodfinds/contracts/state";
import { stateSchema } from "@goodfinds/contracts/state";
import type { SellerConversationSummary } from "@goodfinds/contracts/seller-conversation";
import { createGoodfindsServer } from "@goodfinds/server/mcp";

const urls: Record<Marketplace, string> = {
  facebook_marketplace: "https://www.facebook.com/marketplace/item/123456789012345/",
  ebay: "https://www.ebay.co.uk/itm/123456789012345",
  vinted: "https://www.vinted.co.uk/items/123456789012345-fixture",
  gumtree: "https://www.gumtree.com/p/coffee-makers/fixture/123456789012345",
  autotrader: "https://www.autotrader.co.uk/car-details/123456789012345",
  craigslist: "https://london.craigslist.org/for/d/fixture/123456789012345.html",
};

function fixture(t: TestContext, source: Marketplace, browser: "in_app" | "external" = "in_app") {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-contact-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  let now = Date.now();
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => 0n,
    monotonicTimeNanos: Effect.succeed(0n),
    sleep: () => Effect.void,
  };
  const store = new WorkspaceStore(seedWorkspace(folder));
  const run = (name: string, args: Record<string, unknown> = {}) => {
    const result = Effect.runSync(
      store.request(name, args).pipe(Effect.provideService(Clock.Clock, clock)),
    );
    return {
      ...result,
      state: stateSchema.parse(result.state),
      execution: "execution" in result ? result.execution : undefined,
    };
  };
  run("import_listing_observations", {
    observations: [
      {
        listing_id: "123456789012345",
        title: "Fictional test listing",
        url: urls[source],
        source,
        product: "coffee_machine",
        currency: "GBP",
        price_minor: 20000,
        price_kind: "asking",
        provenance: "manual",
        observed_at: new Date(now).toISOString(),
        availability: "active",
      },
    ],
  });
  const state = () => run("get_workspace").state;
  const listing = state().listings[0];
  assert.ok(listing);
  const report = listingContactReportSchema.parse({
    listing_key: listing.key,
    listing_url: listing.url,
    marketplace: source,
    browser,
    host: "Simulated host",
    profile: "Simulated buyer",
    message: "available",
    offer: "unavailable",
    external_contact: false,
    evidence: "Simulated enabled message composer for this listing",
  });
  const mutation = (name: string, value: Record<string, unknown>) => {
    const current = state();
    return run(name, {
      expected_entity_revision: revisionFor(current, name, value),
      context_id: current.access_context,
      ...value,
    }).state;
  };
  const contact = (overrides: Record<string, unknown> = {}) =>
    mutation("report_listing_contact", { report: { ...report, ...overrides } });
  const session = (status = "signed_in", profile = report.profile) =>
    mutation("report_marketplace_session", {
      report: {
        marketplace: source,
        browser,
        host: report.host,
        profile,
        status,
        evidence: `Simulated account/protected page state: ${status}`,
      },
    });
  const access = (status = "available", overrides: Record<string, unknown> = {}) =>
    mutation("report_browser_access", {
      report: {
        browser,
        host: report.host,
        profile: report.profile,
        status,
        evidence: `Simulated host capability: ${status}`,
        ...overrides,
      },
    });
  if (browser === "external") access();
  mutation("save_settings", { settings: { browser_preference: browser } });
  const readiness = (value = state()) =>
    listingContactState(listing, {
      config: value.config,
      context_id: value.access_context,
      now,
      mode: "live",
    });
  const ready = () => {
    access();
    session();
    contact();
  };
  const html = (value = state(), seller_conversation?: SellerConversationSummary) =>
    renderToStaticMarkup(
      createElement(ListingCard, {
        listing,
        state: value,
        decisions: [],
        sample: false,
        searches: [],
        onNegotiate: () => {},
        ...(seller_conversation ? { seller_conversation } : {}),
      }),
    );
  const contactHtml = () =>
    renderToStaticMarkup(createElement(ContactOptions, { listing, state: state() }));
  const command = (name: string, args: Record<string, unknown> = {}) =>
    run(Object.entries(sellerActions).find(([, value]) => value === name)?.[0] ?? "", {
      listing_key: listing.key,
      ...args,
    });
  const request = () => {
    const c = command("get").state.seller_conversation;
    assert.ok(c);
    const saved = command("save", {
      expected_version: c.version,
      draft: {
        price_minor: 18000,
        currency: "GBP",
        price_period: "once",
        collection: null,
        text: "Simulated reviewed message",
        intent: "offer",
        responds_to: null,
      },
    }).state.seller_conversation;
    assert.ok(saved);
    return command("request", {
      expected_version: saved.version,
      request_id: randomUUID(),
      kind: "send",
    });
  };
  return {
    folder,
    state,
    listing,
    report,
    run,
    mutation,
    contact,
    session,
    access,
    ready,
    contactHtml,
    readiness,
    html,
    command,
    request,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

for (const source of marketplaceSchema.options) {
  for (const browser of ["in_app", "external"] as const) {
    void test(`simulated ${source}/${browser}: login, contact and browser permission are independent`, (t) => {
      const f = fixture(t, source, browser);
      assert.equal(f.readiness().message, false);
      assert.match(f.html(), />Prepare message</u);
      f.contact();
      f.access();
      for (const status of ["signed_out", "unknown", "expired"]) {
        f.session(status);
        assert.equal(f.readiness().message, false, status);
        assert.match(f.html(), />Prepare message</u);
      }
      f.session();
      assert.equal(f.readiness().message, true);
      assert.match(f.html(), />Prepare message</u);
      f.access("denied");
      assert.equal(f.readiness().message, false);
      f.access();
      f.contact({ message: "unavailable", external_contact: true });
      assert.equal(f.readiness().message, false);
      assert.doesNotMatch(f.html(), /Contact is outside the marketplace|Check messaging/u);
      assert.match(f.contactHtml(), /Contact is outside the marketplace/u);
      assert.match(f.html(), />Prepare message</u);
    });
  }
}

void test("contact reports bind to saved marketplace, listing, revision and host context", (t) => {
  const f = fixture(t, "vinted");
  for (const overrides of [
    { listing_key: "vinted:other" },
    { listing_url: "https://www.vinted.co.uk/items/999999-different" },
    { listing_url: "https://attacker.invalid/items/123456789012345-fixture" },
    { marketplace: "ebay" },
  ])
    assert.throws(() => f.contact(overrides), /match the saved listing/u);
  const before = f.state();
  assert.throws(
    () =>
      f.run("report_listing_contact", {
        expected_entity_revision: revisionFor(before, "report_listing_contact", {
          report: f.report,
        }),
        context_id: "different-context",
        report: f.report,
      }),
    /Refresh/u,
  );
  const saved = f.contact();
  assert.throws(
    () =>
      f.run("report_listing_contact", {
        expected_entity_revision: revisionFor(before, "report_listing_contact", {
          report: f.report,
        }),
        context_id: before.access_context,
        report: f.report,
      }),
    /changed/u,
  );
  assert.equal(saved.config.listing_contacts?.[0]?.listing_key, f.listing.key);
  assert.equal(saved.config.listing_contacts?.[0]?.context_id, saved.access_context);
});

void test("settings shows the selected profile's observed sign-in and refuses stale or future badges", (t) => {
  const f = fixture(t, "vinted");
  f.ready();
  const text = (value = f.state()) =>
    renderToStaticMarkup(createElement(BrowserSettings, { state: value, busy: false })).replace(
      /<[^>]*>/gu,
      "",
    );
  assert.match(text(), /VintedSigned in/u);
  f.session("signed_out");
  assert.match(text(), /VintedSign in/u);
  f.session();
  for (const delta of [-3600_000, 3600_000]) {
    const value = structuredClone(f.state());
    const account = value.config.platform_sessions[0];
    assert.ok(account);
    account.checked_at = new Date(Date.now() + delta).toISOString();
    assert.doesNotMatch(text(value), /VintedSigned in/u);
    assert.match(text(value), /VintedCheck needed/u);
  }
  f.access("available", { profile: "Different buyer" });
  assert.doesNotMatch(text(), /VintedSigned in/u);
});

void test("an observed guest message route does not imply guest native-offer access", (t) => {
  const f = fixture(t, "autotrader");
  f.ready();
  f.session("signed_out");
  f.contact({
    message_auth: "not_required",
    offer: "available",
    offer_auth: "required",
    evidence: "Simulated guest composer usable without login; native offer needs login",
  });
  assert.equal(f.readiness().message, true);
  assert.equal(f.readiness().offer, false);
  assert.match(f.html(), />Prepare message</u);
  assert.doesNotMatch(f.html(), /Make an offer on/u);
  f.contact({ message_auth: "unknown" });
  assert.equal(f.readiness().message, false);
  f.contact({ message_auth: "not_required" });
  f.session("unknown");
  assert.equal(f.readiness().message, false);
});

void test("a guest-contact report cannot remove Facebook's authenticated execution requirement", (t) => {
  const f = fixture(t, "facebook_marketplace");
  f.ready();
  f.session("signed_out");
  f.contact({ message_auth: "not_required" });
  assert.equal(f.readiness().message, false);
  const a = f.request().state.seller_conversation?.actions.at(-1);
  assert.ok(a);
  assert.throws(() => f.command("claim", { action_id: a.id, worker_id: randomUUID() }), /sign-in/u);
  assert.equal(f.command("get").state.seller_conversation?.first_sent_at, null);
});

void test("stale, future, wrong-profile and blocked-site evidence cannot enable outreach", (t) => {
  const f = fixture(t, "gumtree", "external");
  f.ready();
  f.access("available", { blocked_domains: ["gumtree.com"] });
  assert.equal(f.readiness().message, false);
  f.access();
  f.session("signed_in", "Other buyer");
  f.access("available", { profile: "Other buyer" });
  assert.equal(f.readiness().message, false);
  f.ready();
  const saved = f.state();
  for (const field of ["browser_access", "platform_sessions", "listing_contacts"] as const) {
    for (const override of [
      { context_id: "previous-server-context" },
      { checked_at: new Date(Date.now() + 3600_000).toISOString() },
      { checked_at: new Date(Date.now() - 3600_000).toISOString() },
    ]) {
      const value = structuredClone(saved);
      const current = value.config[field]?.findLast((item) => item.profile === f.report.profile);
      assert.ok(current);
      Object.assign(current, override);
      assert.equal(f.readiness(value).message, false, `${field} ${JSON.stringify(override)}`);
    }
  }
  f.advance(30 * 60_000 + 1);
  assert.equal(f.readiness().message, false);
});

void test("eBay native offers are independent of messaging and cannot request a generic send", (t) => {
  const f = fixture(t, "ebay");
  f.ready();
  f.contact({ message: "unavailable", offer: "available" });
  assert.equal(f.readiness().message, false);
  assert.equal(f.readiness().offer, true);
  assert.match(f.contactHtml(), /Make an offer on eBay/u);
  assert.match(f.contactHtml(), /Check offer limits/u);
  assert.match(f.html(), />Prepare message</u);
  assert.throws(() => f.request(), /Native offers/u);
  assert.equal(f.command("get").state.seller_conversation?.actions.length, 0);
});

void test("observed Vinted offer bounds enforce item-price minimum, quota, currency and increments", (t) => {
  const f = fixture(t, "vinted");
  f.ready();
  // This £120 floor is fixture evidence, not a claim about current Vinted policy.
  f.contact({
    offer: "available",
    offer_limits: {
      currency: "GBP",
      minimum_minor: 12000,
      maximum_minor: 19900,
      step_minor: 100,
      remaining_offers: 2,
      evidence:
        "Simulated native form states minimum £120, maximum £199, whole pounds; 2 offers remain",
    },
  });
  const observed = f.readiness().observation;
  assert.ok(observed);
  assert.match(String(validatePlatformOffer(observed, 11999, "GBP")), /minimum/u);
  assert.equal(validatePlatformOffer(observed, 12000, "GBP"), null);
  assert.match(String(validatePlatformOffer(observed, 12001, "GBP")), /increment/u);
  assert.match(String(validatePlatformOffer(observed, 20000, "GBP")), /maximum/u);
  assert.match(String(validatePlatformOffer(observed, 12000, "EUR")), /currency/u);
  assert.match(String(validatePlatformOffer(observed, NaN, "GBP")), /positive/u);
  assert.match(f.contactHtml(), /Minimum £120/u);
  assert.equal(f.readiness().offer, true);
  assert.equal(sellerApproach(f.readiness()), "offer_and_message");
  const message = f.request().state.seller_conversation?.actions.at(-1);
  assert.ok(message);
  assert.equal(message.manual_only, true);
  assert.equal(f.command("get").state.seller_conversation?.first_sent_at, null);
  assert.throws(
    () => f.command("claim", { action_id: message.id, worker_id: randomUUID() }),
    /copy\/open/u,
  );
  assert.equal(f.readiness().offer, true);
  const limits = observed.offer_limits;
  assert.ok(limits);
  f.contact({
    offer: "available",
    offer_limits: { ...limits, remaining_offers: 0 },
  });
  assert.equal(f.readiness().offer, false);
  const exhausted = f.readiness().observation;
  assert.ok(exhausted);
  assert.match(String(validatePlatformOffer(exhausted, 12000, "GBP")), /No offers remain/u);
});

void test("an offer note supplies a personal message even without a standalone seller composer", (t) => {
  const f = fixture(t, "vinted");
  f.ready();
  f.contact({
    message: "unavailable",
    offer: "available",
    offer_note: "available",
    evidence: "Simulated native offer with a note field; no standalone composer",
  });
  assert.equal(sellerApproach(f.readiness()), "offer_with_note");
  assert.equal(f.readiness().message, false);
  assert.match(f.contactHtml(), /personal message/u);
  assert.throws(() => f.request(), /message interface/u);
  f.session("signed_out");
  assert.equal(sellerApproach(f.readiness()), "unavailable");
});

void test("seller_conversation falls back according to independently observed message, offer and note routes", (t) => {
  const f = fixture(t, "ebay");
  f.ready();
  assert.equal(sellerApproach(f.readiness()), "message_only");
  f.contact({ offer: "available", offer_note: "unavailable" });
  assert.equal(sellerApproach(f.readiness()), "offer_and_message");
  f.contact({ offer: "available", offer_note: "unavailable", message: "unavailable" });
  assert.equal(sellerApproach(f.readiness()), "offer_only");
  f.contact({ message: "unavailable" });
  assert.equal(sellerApproach(f.readiness()), "unavailable");
  assert.doesNotMatch(f.html(), />Negotiate</u);
  assert.equal(
    listingContactReportSchema.safeParse({ ...f.report, offer_note: "available" }).success,
    false,
  );
});

void test("offer limits require evidence and cannot be invented from marketplace name", (t) => {
  const f = fixture(t, "vinted");
  f.ready();
  f.contact({ offer: "available" });
  const observed = f.readiness().observation;
  assert.ok(observed);
  assert.match(String(validatePlatformOffer(observed, 12000, "GBP")), /limits need checking/u);
  assert.equal(
    listingContactReportSchema.safeParse({
      ...f.report,
      offer_limits: {
        currency: "GBP",
        minimum_minor: 12000,
        maximum_minor: 11000,
        remaining_offers: null,
        evidence: "Fixture",
      },
    }).success,
    false,
  );
});

void test("removed or unverified listings and disabled platforms hide actions even with visible controls", (t) => {
  const f = fixture(t, "vinted");
  f.ready();
  f.contact({ offer: "available" });
  for (const availability of ["removed", "unknown", "reserved", "sold", "unavailable"]) {
    const html = renderToStaticMarkup(
      createElement(ContactOptions, {
        listing: { ...f.listing, availability },
        state: f.state(),
      }),
    );
    assert.doesNotMatch(html, /Make an offer on/u);
    assert.match(html, /Check messaging/u);
  }
  f.mutation("save_settings", {
    settings: { platforms: { vinted: { enabled: false, browser: "default" } } },
  });
  assert.equal(f.readiness().message, false);
  assert.equal(f.readiness().offer, false);
  assert.throws(() => f.request(), /disabled/u);
});

void test("history remains accessible when new contact is unavailable", (t) => {
  const f = fixture(t, "gumtree");
  f.ready();
  f.request();
  f.contact({ message: "unavailable" });
  const summary = f.command("get").state.seller_conversations[0];
  assert.ok(summary);
  assert.match(f.html(f.state(), summary), new RegExp(`>${summary.action_label}<`, "u"));
});

void test("backend blocks unobserved contact and rechecks revoked controls immediately before a Facebook send", (t) => {
  const f = fixture(t, "facebook_marketplace");
  assert.throws(() => f.request(), /message interface/u);
  f.ready();
  const requested = f.request().state.seller_conversation?.actions.at(-1);
  assert.ok(requested);
  const claim = f.command("claim", { action_id: requested.id, worker_id: randomUUID() });
  const token = claim.execution?.lease_token;
  assert.ok(token);
  f.contact({ message: "unavailable" });
  assert.throws(
    () =>
      f.command("prepare", {
        action_id: requested.id,
        lease_token: token,
        identity: {
          listing_id: f.listing.listing_id,
          listing_url: f.listing.url,
          seller_profile_url: "https://www.facebook.com/marketplace/profile/12345/",
          buyer_identity: "Simulated buyer",
          thread_url: "https://www.facebook.com/messages/t/123456/",
          host: f.report.host,
          profile: f.report.profile,
          evidence: "Simulated matching identity",
        },
      }),
    /contact is unavailable/u,
  );
  assert.equal(f.command("get").state.seller_conversation?.first_sent_at, null);
});

void test("MCP contact-report tool persists listing evidence without sending", async (t) => {
  const f = fixture(t, "vinted");
  const { server, calls } = createGoodfindsServer(seedWorkspace(f.folder));
  t.after(() => server.close());
  const call = calls.get("report_goodfinds_listing_contact");
  assert.ok(call);
  const state: GoodfindsState = f.state();
  const result = await call({
    mode: "live",
    expected_entity_revision: state.revisions.evidence,
    context_id: state.access_context,
    report: f.report,
  });
  assert.equal(result.isError, undefined);
  assert.equal(f.state().config.listing_contacts?.length, 1);
  assert.equal(f.state().seller_conversations.length, 0);
});
