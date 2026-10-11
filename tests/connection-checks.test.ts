import { seedWorkspace } from "./helpers/workspace.ts";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect, Exit } from "effect";
import { nativeOptions } from "./helpers/native-mcp.ts";
import { NativeWorkspace } from "./helpers/native-workspace.ts";
import { createNativeServer } from "./helpers/native-mcp.ts";
import type {
  ConnectionCheckRun,
  ConnectionCheckObservation,
} from "@goodfinds/contracts/connection-checks";
import { connectionCheckResultSchema } from "@goodfinds/contracts/connection-checks";
import { stateFromToolResult } from "@goodfinds/contracts/state";
import { MARKETPLACES } from "@goodfinds/contracts/integrations";

function observation(): ConnectionCheckObservation {
  const identity = {
    browser: "external" as const,
    browser_id: "com.google.Chrome",
    host: "local",
    profile: "isolated-profile",
  };
  return {
    marketplace: "facebook_marketplace",
    access: {
      ...identity,
      status: "available",
      evidence: "Fixture controlled page",
      blocked_domains: [],
    },
    session: {
      ...identity,
      marketplace: "facebook_marketplace",
      status: "signed_in",
      evidence: "Fixture account menu",
    },
  };
}
function parsed(raw: { structuredContent?: unknown; isError?: boolean | undefined }) {
  assert.equal(raw.isError, undefined, JSON.stringify(raw));
  const result = connectionCheckResultSchema.parse(raw.structuredContent);
  assert.ok(result.run);
  return result.run;
}

function fixture(t: TestContext, mixed = false) {
  const root = mkdtempSync(resolve(tmpdir(), "goodfinds-connection-check-"));
  const store = new NativeWorkspace(seedWorkspace(root));
  const initial = Effect.runSync(store.request("get_workspace")).state;
  Effect.runSync(
    store.request("save_settings", {
      expected_entity_revision: initial.revisions.settings,
      settings: {
        browser_preference: "external",
        platforms: Object.fromEntries(
          MARKETPLACES.map((item) => [
            item.id,
            {
              enabled: item.id === "facebook_marketplace" || (mixed && item.id === "ebay"),
              browser: item.id === "ebay" ? "in_app" : "default",
            },
          ]),
        ),
      },
    }),
  );
  let browserId: string | null = "com.google.Chrome";
  const app = createNativeServer(
    seedWorkspace(root),
    nativeOptions(root, null, async () =>
      browserId ? { id: browserId, name: "Fixture Browser" } : null,
    ),
  );
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await app.server.close();
    }
  };
  t.after(async () => {
    await close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = async (name: string, args: unknown) => {
    const tool = app.calls.get(name);
    assert.ok(tool);
    return tool(args);
  };
  const state = async (mode: "live" | "sample" = "live") =>
    stateFromToolResult(await call("open_goodfinds_panel", { mode }));
  const read = async (id?: string) =>
    connectionCheckResultSchema.parse(
      (
        await call("get_goodfinds_connection_check", {
          mode: "live",
          ...(id ? { run_id: id } : {}),
        })
      ).structuredContent,
    ).run;
  const start = async (requestId = randomUUID(), mode: "live" | "sample" = "live") =>
    parsed(
      await call("start_goodfinds_connection_check", {
        mode,
        request_id: requestId,
        expected_entity_revision: (await state(mode)).revisions.settings,
      }),
    );
  const claim = async (run: ConnectionCheckRun, workerId: string = randomUUID()) =>
    parsed(
      await call("claim_goodfinds_connection_check", {
        mode: "live",
        run_id: run.id,
        expected_version: run.version,
        worker_id: workerId,
        agent_id: "native-child",
        parent_thread_id: "buying-chat",
        execution: { profile: "collection", model: "gpt-6-luna", reasoning_effort: "xhigh" },
      }),
    );
  const complete = async (run: ConnectionCheckRun, observations = [observation()]) => {
    assert.ok(run.worker);
    return call("complete_goodfinds_connection_check", {
      mode: "live",
      run_id: run.id,
      expected_version: run.version,
      worker_id: run.worker.id,
      observations,
    });
  };
  return {
    root,
    store,
    app,
    call,
    state,
    read,
    start,
    claim,
    complete,
    close,
    setBrowser: (id: string | null) => {
      browserId = id;
    },
  };
}

void test("connection checks queue without browser work, deduplicate starts and expose worker launch settings", async (t) => {
  const f = fixture(t);
  const before = await f.state();
  assert.equal(await f.read(), null);
  const requestId = randomUUID();
  const run = await f.start(requestId);
  assert.equal(run.status, "queued");
  assert.equal(run.worker, null);
  assert.deepEqual(run.results, []);
  assert.equal((await f.start(requestId)).id, run.id);
  assert.equal((await f.start()).id, run.id);
  assert.deepEqual((await f.state()).config, before.config);
  const result = connectionCheckResultSchema.parse(
    (await f.call("get_goodfinds_connection_check", { mode: "live", run_id: run.id }))
      .structuredContent,
  );
  assert.deepEqual(result.execution.spawn, {
    model: "gpt-6-luna",
    reasoning_effort: "xhigh",
    fork_turns: "none",
  });
  assert.equal(
    (
      await f.call("start_goodfinds_connection_check", {
        mode: "live",
        request_id: randomUUID(),
        expected_entity_revision: "0".repeat(64),
      })
    ).isError,
    true,
  );
});

void test("only a native worker claim establishes running and renewal retains its identity and model audit", async (t) => {
  const f = fixture(t);
  const queued = await f.start();
  const premature = await f.call("complete_goodfinds_connection_check", {
    mode: "live",
    run_id: queued.id,
    expected_version: queued.version,
    worker_id: randomUUID(),
    observations: [observation()],
  });
  assert.equal(premature.isError, true);
  assert.equal(
    (
      await f.call("claim_goodfinds_connection_check", {
        mode: "live",
        run_id: queued.id,
        expected_version: queued.version,
        worker_id: randomUUID(),
        agent_id: "parent",
        parent_thread_id: "parent",
      })
    ).isError,
    true,
  );
  const claimed = await f.claim(queued);
  assert.equal(claimed.status, "running");
  assert.ok(claimed.worker);
  assert.equal((await f.claim(queued, claimed.worker.id)).version, claimed.version);
  assert.equal(
    (
      await f.call("renew_goodfinds_connection_check", {
        mode: "live",
        run_id: claimed.id,
        worker_id: randomUUID(),
      })
    ).isError,
    true,
  );
  assert.equal(await f.claim(queued).catch(() => null), null);
  const renewed = parsed(
    await f.call("renew_goodfinds_connection_check", {
      mode: "live",
      run_id: claimed.id,
      worker_id: claimed.worker.id,
    }),
  );
  assert.ok(renewed.version > claimed.version);
  assert.deepEqual(renewed.worker?.execution, claimed.worker.execution);
  assert.equal((await f.complete(claimed)).isError, true);
  assert.equal(parsed(await f.complete(renewed)).status, "complete");
});

void test("completion saves paired evidence once and only exact terminal retries are idempotent", async (t) => {
  const f = fixture(t);
  const before = await f.state();
  const claimed = await f.claim(await f.start());
  const finished = parsed(await f.complete(claimed));
  assert.equal(finished.results[0]?.status, "signed_in");
  assert.ok(finished.results[0]?.checked_at);
  const after = await f.state();
  assert.equal(after.config.browser_access[0]?.browser_id, "com.google.Chrome");
  assert.equal(after.config.platform_sessions[0]?.profile, "isolated-profile");
  assert.equal(
    after.config.browser_access[0]?.checked_at,
    after.config.platform_sessions[0]?.checked_at,
  );
  assert.notEqual(after.revision, before.revision);
  assert.deepEqual(parsed(await f.complete(claimed)), finished);
  assert.equal((await f.state()).revision, after.revision);
  const changed = observation();
  assert.ok(changed.session);
  changed.session.status = "signed_out";
  assert.equal((await f.complete(claimed, [changed])).isError, true);
});

void test("cancellation rejects queued claims, renewal and late results while preserving prior evidence", async (t) => {
  const f = fixture(t);
  parsed(await f.complete(await f.claim(await f.start())));
  const before = await f.state();
  const queued = await f.start();
  assert.equal(
    parsed(await f.call("cancel_goodfinds_connection_check", { mode: "live", run_id: queued.id }))
      .status,
    "cancelled",
  );
  assert.equal(await f.claim(queued).catch(() => null), null);
  const running = await f.claim(await f.start());
  assert.ok(running.worker);
  await f.call("cancel_goodfinds_connection_check", { mode: "live", run_id: running.id });
  assert.equal(
    (
      await f.call("renew_goodfinds_connection_check", {
        mode: "live",
        run_id: running.id,
        worker_id: running.worker.id,
      })
    ).isError,
    true,
  );
  assert.equal((await f.complete(running)).isError, true);
  assert.equal((await f.read())?.status, "cancelled");
  assert.deepEqual((await f.state()).config, before.config);
});

void test("the parent can record failed delegation only before a worker claims the check", async (t) => {
  const f = fixture(t);
  const before = await f.state();
  const queued = await f.start();
  const unavailable = parsed(
    await f.call("interrupt_goodfinds_connection_check", {
      mode: "live",
      run_id: queued.id,
      expected_version: queued.version,
      status: "unavailable",
      reason: "Host has no native delegation tool.",
    }),
  );
  assert.equal(unavailable.status, "unavailable");
  assert.deepEqual((await f.state()).config, before.config);
  const running = await f.claim(await f.start());
  const args = {
    mode: "live",
    run_id: running.id,
    expected_version: running.version,
    status: "unavailable",
    reason: "Selected route is unavailable.",
  };
  assert.equal((await f.call("interrupt_goodfinds_connection_check", args)).isError, true);
  assert.equal(
    parsed(
      await f.call("interrupt_goodfinds_connection_check", {
        ...args,
        worker_id: running.worker?.id,
      }),
    ).status,
    "unavailable",
  );
});

void test("mismatched browser profiles and changed selected routes reject evidence atomically", async (t) => {
  const f = fixture(t);
  const before = await f.state();
  const run = await f.claim(await f.start());
  const wrong = observation();
  assert.ok(wrong.session);
  wrong.session.profile = "another-profile";
  assert.equal((await f.complete(run, [wrong])).isError, true);
  assert.deepEqual((await f.state()).config, before.config);
  f.setBrowser("com.apple.Safari");
  assert.equal((await f.complete(run)).isError, true);
  assert.deepEqual((await f.state()).config, before.config);
});

void test("the server accepts host-observed in-app and non-Chrome routes without choosing a browser", async (t) => {
  const f = fixture(t, true);
  f.setBrowser("com.apple.Safari");
  const run = await f.claim(await f.start());
  const device = observation();
  device.access.browser_id = "com.apple.Safari";
  assert.ok(device.session);
  device.session.browser_id = "com.apple.Safari";
  const inApp = observation();
  inApp.marketplace = "ebay";
  inApp.access = { ...inApp.access, browser: "in_app", browser_id: "iab", profile: "iab-profile" };
  assert.ok(inApp.session);
  inApp.session = {
    ...inApp.session,
    marketplace: "ebay",
    browser: "in_app",
    browser_id: "iab",
    profile: "iab-profile",
  };
  const finished = parsed(await f.complete(run, [device, inApp]));
  assert.equal(
    finished.results.every((item) => item.status === "signed_in"),
    true,
  );
  assert.equal((await f.state()).config.browser_access.length, 2);
});

void test("partial checks leave unsupported targets unknown without refreshing their evidence", async (t) => {
  const f = fixture(t, true);
  const finished = parsed(await f.complete(await f.claim(await f.start())));
  assert.deepEqual(
    finished.results.find((item) => item.marketplace === "ebay"),
    { marketplace: "ebay", browser: "in_app", status: "unknown", checked_at: null },
  );
  assert.match(finished.message, /unknown/);
  assert.equal(
    (await f.state()).config.browser_access.some((item) => item.browser === "in_app"),
    false,
  );
});

void test("site-specific blocks preserve connected access and contradictory route failures roll back", async (t) => {
  const f = fixture(t);
  const before = await f.state();
  const blocked: ConnectionCheckObservation = {
    marketplace: "ebay",
    access: { ...observation().access, status: "denied", blocked_domains: ["ebay.co.uk"] },
    session: null,
  };
  await Effect.runPromise(
    f.store.request("report_connections", {
      expected_entity_revision: before.revisions.evidence,
      context_id: before.access_context,
      reports: [observation(), blocked],
    }),
  );
  const connected = await f.state();
  assert.equal(connected.config.browser_access[0]?.status, "available");
  assert.deepEqual(connected.config.browser_access[0]?.blocked_domains, ["ebay.co.uk"]);
  const contradictory = {
    ...blocked,
    access: { ...blocked.access, status: "unavailable", blocked_domains: [] },
  };
  assert.ok(
    Exit.isFailure(
      await Effect.runPromiseExit(
        f.store.request("report_connections", {
          expected_entity_revision: connected.revisions.evidence,
          context_id: connected.access_context,
          reports: [observation(), contradictory],
        }),
      ),
    ),
  );
  assert.deepEqual((await f.state()).config, connected.config);
});
