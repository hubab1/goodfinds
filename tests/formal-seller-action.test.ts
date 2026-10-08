import { seedWorkspace } from "./helpers/workspace.ts";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Clock, Effect } from "effect";
import { z } from "zod";
import { sellerActions } from "@goodfinds/contracts/tool-names";
import {
  sellerActionStatuses,
  sellerBlockers,
  sellerDraftBlockers,
  expiredSellerAction,
} from "@goodfinds/contracts/seller-action-model";
import type { Conversation, SellerAction } from "@goodfinds/contracts/seller-conversation";
import { WorkspaceStore } from "./reference-server/src/platform/workspace-sqlite.ts";
import { auditFormalProbe, evaluateSellerCases, formalDirectory } from "../scripts/formal-model.ts";
import properties from "../formal/properties.json" with { type: "json" };
import { revisionFor } from "./helpers/revisions.ts";

const sellerState = z.object({
  status: z.enum(sellerActionStatuses),
  kind: z.enum(["send", "check"]),
  draft: z.string(),
  lease: z.object({ token: z.string(), expiresAt: z.number() }).nullable(),
  permits: z.number(),
});
type SellerState = z.infer<typeof sellerState>;
const answers = z.array(sellerState.nullable());
const start = Date.parse("2026-10-07T12:00:00Z");

function fixture(t: TestContext) {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-formal-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  let now = start;
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
  const request = (operation: string, args: Record<string, unknown> = {}) =>
    Effect.runSync(store.request(operation, args).pipe(Effect.provideService(Clock.Clock, clock)));
  const state = () => request("get_workspace").state;
  return {
    folder,
    store,
    request,
    state,
    advance: (by: number) => {
      now += by;
    },
    now: () => now,
  };
}

function sellerFixture(t: TestContext) {
  const f = fixture(t);
  const imported = f.request("import_listing_observations", {
    observations: [
      {
        listing_id: "123456789012345",
        title: "Formal fixture monitor",
        product: "mac_mini",
        url: "https://www.facebook.com/marketplace/item/123456789012345/",
        source: "facebook_marketplace",
        price_minor: 20000,
        price_kind: "asking",
        currency: "GBP",
        provenance: "manual",
        observed_at: new Date(start).toISOString(),
        availability: "active",
        seller_profile_url: "https://www.facebook.com/marketplace/profile/12345/",
      },
    ],
  }).state;
  const listing = imported.listings[0];
  assert.ok(listing);
  const identity = {
    listing_url: listing.url,
    listing_id: listing.listing_id,
    seller_profile_url: "https://www.facebook.com/marketplace/profile/12345/",
    buyer_identity: "Fixture buyer",
    thread_url: "https://www.facebook.com/messages/t/123456/",
    host: "Codex",
    profile: "Fixture",
    evidence: "Fixture listing and thread match",
  };
  const report = (operation: string, value: Record<string, unknown>) => {
    const state = f.state();
    f.request(operation, {
      expected_entity_revision: revisionFor(state, operation),
      context_id: state.access_context,
      report: value,
    });
  };
  report("report_browser_access", {
    browser: "in_app",
    status: "available",
    host: "Codex",
    profile: "Fixture",
    evidence: "Fixture access",
  });
  report("report_marketplace_session", {
    marketplace: "facebook_marketplace",
    browser: "in_app",
    status: "signed_in",
    host: "Codex",
    profile: "Fixture",
    evidence: "Fixture account",
  });
  report("report_listing_contact", {
    listing_key: listing.key,
    listing_url: listing.url,
    marketplace: "facebook_marketplace",
    browser: "in_app",
    host: "Codex",
    profile: "Fixture",
    message: "available",
    offer: "unavailable",
    external_contact: false,
    evidence: "Fixture contact",
  });
  const command = (operation: string, args: Record<string, unknown> = {}) => {
    const name = Object.entries(sellerActions).find(([, value]) => value === operation)?.[0];
    assert.ok(name);
    return f.request(name, { listing_key: listing.key, ...args });
  };
  const conversation = () => {
    const c = command("get").state.seller_conversation;
    assert.ok(c);
    return c;
  };
  const draft = {
    text: "Hi, would you consider £180?",
    price_minor: 18000,
    currency: "GBP",
    price_period: "once",
    collection: null,
    intent: "offer",
    responds_to: null,
  };
  command("save", { expected_version: conversation().version, draft });
  const requested = command("request", {
    expected_version: conversation().version,
    request_id: randomUUID(),
    kind: "send",
  });
  const action = requested.state.seller_conversation?.actions.at(-1);
  assert.ok(action);
  return { ...f, command, conversation, identity, action };
}

function projectSeller(a: SellerAction, permits: number): SellerState {
  return {
    status: a.status,
    kind: a.kind,
    draft: a.draft?.text ?? "",
    lease:
      a.lease_token && a.lease_expires_at
        ? { token: a.lease_token, expiresAt: Date.parse(a.lease_expires_at) }
        : null,
    permits,
  };
}
const sellerContext = (now = start) => ({
  now,
  token: "lease",
  nextToken: "replacement",
  workerPresent: true,
  routeValid: true,
  identityValid: true,
  draftReady: true,
  conversationOpen: true,
  evidencePresent: true,
  evidenceMatches: true,
});

void test(
  "Lean seller gates match TypeScript through permit, identity, evidence and expiry boundaries",
  { timeout: 300_000 },
  async (t) => {
    const f = sellerFixture(t);
    const base = f.conversation(),
      config = f.state().config,
      contextId = f.state().access_context;
    const variants = [
      {},
      { routeValid: false },
      { identityValid: false },
      { routeValid: false, identityValid: false },
      { draftReady: false },
      { conversationOpen: false },
      { draftReady: false, conversationOpen: false },
      { evidencePresent: false },
      { evidenceMatches: false },
      { token: "wrong" },
      { workerPresent: false },
    ];
    const cases: unknown[] = [],
      expected: boolean[] = [];
    const expiries: unknown[] = [],
      expiredExpected: SellerState[] = [];
    for (const status of sellerActionStatuses)
      for (const kind of ["send", "check"] as const)
        for (const expiry of [null, start, start + 300000]) {
          const raw = {
            ...f.action,
            status,
            kind,
            worker_id: expiry === null ? null : "worker",
            lease_token: expiry === null ? null : "lease",
            lease_expires_at: expiry === null ? null : new Date(expiry).toISOString(),
          };
          const permits = status === "ready_to_send" || status === "uncertain" ? 1 : 0;
          const a = expiredSellerAction(raw, start);
          expiries.push({
            state: projectSeller(raw, permits),
            context: sellerContext(),
            event: "expire",
          });
          expiredExpected.push(projectSeller(a, permits));
          for (const variant of variants) {
            const context = { ...sellerContext(), ...variant };
            const c: Conversation = {
              ...base,
              actions: [a],
              outcome: context.conversationOpen ? "open" : "bought",
            };
            const guard = {
              now: start,
              config: context.routeValid
                ? config
                : {
                    ...config,
                    platforms: {
                      ...config.platforms,
                      facebook_marketplace: {
                        browser: "default" as const,
                        ...config.platforms.facebook_marketplace,
                        enabled: false,
                      },
                    },
                  },
              mode: "live" as const,
              context_id: contextId,
              worker_id: context.workerPresent ? "worker" : undefined,
              lease_token: context.token,
              identity: context.identityValid ? f.identity : { ...f.identity, listing_id: "wrong" },
              availability: context.draftReady ? ("active" as const) : ("unknown" as const),
              evidence: context.evidencePresent
                ? context.evidenceMatches
                  ? `Bubble: ${a.draft?.text}`
                  : "Different text"
                : "",
            };
            const append = (event: unknown, accepted: boolean) => {
              cases.push({ state: projectSeller(a, permits), context, event });
              expected.push(accepted);
            };
            append(
              "claim",
              ["sent", "checked", "not_sent", "cancelled"].includes(status) ||
                sellerBlockers(c, "claim", guard, a).length === 0,
            );
            append("cancel", sellerBlockers(c, "cancel", guard, a).length === 0);
            const readiness = sellerDraftBlockers(c, a.draft, guard);
            const blocking = sellerBlockers(c, "permit", guard, a).filter(
              (item) =>
                !readiness.some((issue) => issue.code === item.code) &&
                !(readiness.length && item.code === "conversation_closed"),
            );
            append("prepare", blocking.length === 0);
            for (const result of ["sent", "checked", "not_sent", "blocked", "uncertain"] as const)
              append(
                { report: { result } },
                (["sent", "checked", "not_sent"].includes(a.status) && a.status === result) ||
                  sellerBlockers(c, "result", { ...guard, result }, a).length === 0,
              );
          }
        }
    const output = await evaluateSellerCases(cases, answers);
    assert.equal(output.length, cases.length);
    output.forEach((next, i) => assert.equal(next !== null, expected[i], JSON.stringify(cases[i])));
    const expired = await evaluateSellerCases(expiries, answers);
    assert.deepEqual(expired, expiredExpected);
    process.stdout.write(
      `Compared ${cases.length} seller decisions and ${expiries.length} expiry projections.\n`,
    );
  },
);

void test(
  "Lean seller histories match stored actions through uncertainty and reconciliation",
  { timeout: 300_000 },
  async (t) => {
    const f = sellerFixture(t);
    const cases: unknown[] = [],
      expected: (SellerState | null)[] = [];
    let permits = 0;
    const action = () => {
      const a = f.conversation().actions.find((candidate) => candidate.id === f.action.id);
      assert.ok(a);
      return a;
    };
    function event(operation: string, modelEvent: unknown, args: Record<string, unknown> = {}) {
      const before = action();
      const beforePermits = permits;
      const token = typeof args["lease_token"] === "string" ? args["lease_token"] : "lease";
      const context = { ...sellerContext(f.now()), token };
      let result: ReturnType<typeof f.command> | undefined;
      try {
        result = f.command(operation, { action_id: before.id, ...args });
      } catch {
        /* checked against Lean below */
      }
      if (result?.execution?.send_permitted) permits += 1;
      const next = action();
      context.nextToken = next.lease_token ?? "unused";
      cases.push({
        state: projectSeller(before, beforePermits),
        context,
        event: modelEvent,
      });
      expected.push(result ? projectSeller(next, permits) : null);
    }
    event("handoff", "handoff");
    event("claim", "claim", { worker_id: randomUUID() });
    const token = action().lease_token;
    assert.ok(token);
    event("prepare", "prepare", { lease_token: token, identity: f.identity });
    assert.equal(action().status, "ready_to_send");
    event("prepare", "prepare", { lease_token: token, identity: f.identity });
    event("cancel", "cancel");
    const beforeExpiry = projectSeller(action(), permits);
    f.advance(300000);
    cases.push({ state: beforeExpiry, context: sellerContext(f.now()), event: "expire" });
    expected.push(projectSeller(action(), permits));
    assert.equal(action().status, "uncertain");
    event("claim", "claim", { worker_id: randomUUID() });
    const replacement = action().lease_token;
    assert.ok(replacement);
    assert.notEqual(replacement, token);
    event("prepare", "prepare", { lease_token: replacement, identity: f.identity });
    event(
      "complete",
      { report: { result: "sent" } },
      {
        lease_token: token,
        result: "sent",
        evidence: `Bubble: ${f.action.draft?.text}`,
        identity: f.identity,
      },
    );
    event(
      "complete",
      { report: { result: "sent" } },
      {
        lease_token: replacement,
        result: "sent",
        evidence: `Bubble: ${f.action.draft?.text}`,
        identity: f.identity,
      },
    );
    assert.equal(action().status, "sent");
    assert.equal(permits, 1);
    const output = await evaluateSellerCases(cases, answers);
    assert.deepEqual(output, expected);
  },
);

void test("documented formal properties refer to actual proof declarations", async () => {
  const sources = await Promise.all(
    properties.models.map(async (model) => ({
      model,
      source: await readFile(resolve(formalDirectory, model.source), "utf8"),
    })),
  );
  for (const { model, source } of sources) {
    assert.ok(source.includes(`namespace ${model.namespace}`));
    for (const property of model.properties) {
      for (const theorem of property.theorems)
        assert.match(
          source,
          new RegExp(`^theorem ${theorem}\\b`, "mu"),
          `${model.name}.${property.id}`,
        );
    }
  }
});

void test(
  "the Lean dependency audit rejects admitted proofs and custom axioms",
  { timeout: 300_000 },
  async () => {
    await assert.rejects(
      auditFormalProbe(
        "import Goodfinds.Audit\nnamespace Goodfinds.SellerAction\ntheorem incomplete : False := by sorry\nend Goodfinds.SellerAction\n#audit_formal_proofs\n",
      ),
      /unapproved axiom sorryAx/u,
    );
    await assert.rejects(
      auditFormalProbe(
        "import Goodfinds.Audit\nnamespace Goodfinds.SellerAction\naxiom unexpected : False\ntheorem unsupported : False := unexpected\nend Goodfinds.SellerAction\n#audit_formal_proofs\n",
      ),
      /unapproved axiom Goodfinds.SellerAction.unexpected/u,
    );
  },
);
