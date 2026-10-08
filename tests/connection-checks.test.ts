import { seedWorkspace } from "./helpers/workspace.ts";
import { connectionCheckStorage } from "../apps/server/src/platform/connection-checks-sqlite.ts";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { Effect, Exit, Layer } from "effect";
import { Backend, backendLayer } from "../apps/server/src/entrypoints/backend.ts";
import { WorkspaceStore } from "../apps/server/src/platform/workspace-sqlite.ts";
import { createGoodfindsServer } from "../apps/server/src/entrypoints/mcp.ts";
import { ConnectionChecks } from "../apps/server/src/connections/checks.ts";
import type {
  ConnectionCheckRun,
  ConnectionCheckObservation,
} from "@goodfinds/contracts/connection-checks";
import {
  connectionCheckResultSchema,
  CONNECTION_CHECK_DISPATCH_MS,
  CONNECTION_CHECK_LEASE_MS,
  CONNECTION_CHECK_TIMEOUT_MS,
} from "@goodfinds/contracts/connection-checks";
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
  const store = new WorkspaceStore(seedWorkspace(root));
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
  const layer = Layer.effect(
    Backend,
    Effect.map(Backend, (backend) => ({
      ...backend,
      request: (
        action: Parameters<typeof backend.request>[0],
        args: Parameters<typeof backend.request>[1],
        mode: "live" | "sample",
        guard?: Parameters<typeof backend.request>[3],
      ) =>
        backend.request(action, args, mode, guard).pipe(
          Effect.map((result) => {
            result.state.device_browser = browserId
              ? { id: browserId, name: "Fixture Browser" }
              : null;
            return result;
          }),
        ),
    })),
  ).pipe(Layer.provide(backendLayer(root, null, () => Promise.resolve(null))));
  const app = createGoodfindsServer(seedWorkspace(root), layer);
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

function completionInput(run: ConnectionCheckRun) {
  return {
    mode: "live",
    run_id: run.id,
    expected_version: run.version,
    worker_id: run.worker?.id,
    observations: [observation()],
  };
}

async function coordinator(t: TestContext) {
  const f = fixture(t);
  const state = await f.state();
  let now = Date.now();
  const ports = {
    readState: () => Promise.resolve(state),
    record: async (
      observations: readonly ConnectionCheckObservation[],
      current: typeof state,
      _mode: "live" | "sample",
      signal: AbortSignal,
      guard: (config: typeof state.config) => void,
    ) => {
      signal.throwIfAborted();
      return (
        await Effect.runPromise(
          f.store.request(
            "report_connections",
            {
              expected_entity_revision: current.revisions.evidence,
              context_id: current.access_context,
              reports: [...observations],
            },
            guard,
          ),
        )
      ).state;
    },
  };
  const checks = new ConnectionChecks(connectionCheckStorage(f.root), ports, () => now);
  t.after(() => checks.close());
  const queued = (
    await checks.start({
      mode: "live",
      request_id: randomUUID(),
      expected_entity_revision: state.revisions.settings,
    })
  ).run;
  assert.ok(queued);
  const claim = async (run: ConnectionCheckRun) => {
    const next = (
      await checks.claim({
        mode: "live",
        run_id: run.id,
        expected_version: run.version,
        worker_id: randomUUID(),
        agent_id: "child",
      })
    ).run;
    assert.ok(next);
    return next;
  };
  return {
    f,
    ports,
    state,
    checks,
    queued,
    claim,
    completion: completionInput,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

void test("queued dispatch and claimed leases expire durably and cannot be revived", async (t) => {
  const c = await coordinator(t);
  c.advance(CONNECTION_CHECK_DISPATCH_MS + 1);
  assert.equal((await c.checks.read({ mode: "live" })).run?.status, "interrupted");
  await assert.rejects(c.claim(c.queued));
  const next = (
    await c.checks.start({
      mode: "live",
      request_id: randomUUID(),
      expected_entity_revision: c.state.revisions.settings,
    })
  ).run;
  assert.ok(next);
  const running = await c.claim(next);
  c.advance(CONNECTION_CHECK_LEASE_MS + 1);
  await assert.rejects(c.checks.complete(c.completion(running)));
  await assert.rejects(
    c.checks.renew({ mode: "live", run_id: running.id, worker_id: running.worker?.id }),
  );
  assert.equal((await c.checks.read({ mode: "live" })).run?.status, "interrupted");
  assert.deepEqual((await c.f.state()).config, c.state.config);
});

void test("heartbeats cannot extend a check beyond its total time limit", async (t) => {
  const c = await coordinator(t);
  const run = await c.claim(c.queued);
  for (let elapsed = 60_000; elapsed < CONNECTION_CHECK_TIMEOUT_MS; elapsed += 60_000) {
    c.advance(60_000);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each heartbeat follows advancing the same live lease's clock.
    const renewed = await c.checks.renew({
      mode: "live",
      run_id: run.id,
      worker_id: run.worker?.id,
    });
    assert.equal(renewed.run?.status, "running");
  }
  c.advance(60_001);
  assert.equal((await c.checks.read({ mode: "live" })).run?.status, "interrupted");
});

void test("cancellation by another coordinator during a delayed save prevents an evidence commit", async (t) => {
  const c = await coordinator(t);
  let reached!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((accept) => {
    reached = accept;
  });
  const gate = new Promise<void>((accept) => {
    release = accept;
  });
  const checks = new ConnectionChecks(connectionCheckStorage(c.f.root), {
    ...c.ports,
    record: async (...args) => {
      reached();
      await gate;
      return c.ports.record(...args);
    },
  });
  t.after(() => checks.close());
  const run = await c.claim(c.queued);
  const completion = checks.complete(c.completion(run));
  await waiting;
  await c.checks.cancel({ mode: "live", run_id: run.id });
  release();
  await assert.rejects(completion);
  assert.equal((await c.checks.read({ mode: "live" })).run?.status, "cancelled");
  assert.deepEqual((await c.f.state()).config, c.state.config);
});

void test("changed settings during a delayed save fail the guard inside the writer transaction", async (t) => {
  const c = await coordinator(t);
  const checks = new ConnectionChecks(connectionCheckStorage(c.f.root), {
    ...c.ports,
    record: async (...args) => {
      await Effect.runPromise(
        c.f.store.request("save_settings", {
          expected_entity_revision: c.state.revisions.settings,
          settings: { browser_preference: "in_app" },
        }),
      );
      return c.ports.record(...args);
    },
  });
  t.after(() => checks.close());
  const run = await c.claim(c.queued);
  await assert.rejects(checks.complete(c.completion(run)), /Browser selection changed/);
  assert.deepEqual((await c.f.state()).config.platform_sessions, c.state.config.platform_sessions);
  assert.equal((await c.checks.read({ mode: "live" })).run?.status, "failed");
});

void test("a delayed state read cannot save results after cancellation", async (t) => {
  const c = await coordinator(t);
  const run = await c.claim(c.queued);
  let reached!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((accept) => {
    reached = accept;
  });
  const gate = new Promise<void>((accept) => {
    release = accept;
  });
  let writes = 0;
  const checks = new ConnectionChecks(connectionCheckStorage(c.f.root), {
    ...c.ports,
    readState: async () => {
      reached();
      await gate;
      return c.state;
    },
    record: (...args) => {
      writes++;
      return c.ports.record(...args);
    },
  });
  t.after(() => checks.close());
  const completion = checks.complete(c.completion(run));
  await waiting;
  await c.checks.cancel({ mode: "live", run_id: run.id });
  release();
  await assert.rejects(completion);
  assert.equal(writes, 0);
});

void test("a durable completion reservation prevents another coordinator from saving concurrently", async (t) => {
  const c = await coordinator(t);
  const run = await c.claim(c.queued);
  let reached!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((accept) => {
    reached = accept;
  });
  const gate = new Promise<void>((accept) => {
    release = accept;
  });
  let writes = 0;
  const checks = new ConnectionChecks(connectionCheckStorage(c.f.root), {
    ...c.ports,
    record: async (...args) => {
      reached();
      await gate;
      writes++;
      return c.ports.record(...args);
    },
  });
  t.after(() => checks.close());
  const completion = checks.complete(c.completion(run));
  await waiting;
  const saving = (await c.checks.read({ mode: "live", run_id: run.id })).run;
  assert.ok(saving);
  await assert.rejects(c.checks.complete(c.completion(saving)), /already being saved/);
  release();
  assert.equal((await completion).run?.status, "complete");
  assert.equal(writes, 1);
});

void test("a different access context cannot claim or relabel another connection's check", async (t) => {
  const c = await coordinator(t);
  const other = new ConnectionChecks(connectionCheckStorage(c.f.root), {
    ...c.ports,
    readState: () => Promise.resolve({ ...c.state, access_context: "different-host-session" }),
  });
  t.after(() => other.close());
  assert.equal((await other.read({ mode: "live", run_id: c.queued.id })).run, null);
  await assert.rejects(
    other.claim({
      mode: "live",
      run_id: c.queued.id,
      expected_version: c.queued.version,
      worker_id: randomUUID(),
      agent_id: "child",
    }),
    /original Goodfinds connection/,
  );
});

void test("existing terminal records remain readable without worker/version metadata", async (t) => {
  const f = fixture(t);
  const finished = parsed(await f.complete(await f.claim(await f.start())));
  const before = await f.state();
  const db = new Database(resolve(f.root, "connections.sqlite"));
  const row = db
    .query<{ data: string }, [string]>(
      "SELECT document_json AS data FROM connection_checks WHERE id=?",
    )
    .get(finished.id);
  assert.ok(row);
  const legacy = z.record(z.string(), z.unknown()).parse(JSON.parse(row.data) as unknown);
  delete legacy["worker"];
  delete legacy["version"];
  db.query("UPDATE connection_checks SET document_json=? WHERE id=?").run(
    JSON.stringify(legacy),
    finished.id,
  );
  db.close();
  const read = await f.read(finished.id);
  assert.equal(read?.status, "complete");
  assert.equal(read?.worker, null);
  assert.equal(read?.version, 1);
  assert.deepEqual(read?.results, finished.results);
  assert.deepEqual((await f.state()).config, before.config);
});

void test("sample checks are isolated and server shutdown interrupts queued and running work", async (t) => {
  const f = fixture(t);
  assert.equal((await f.start(randomUUID(), "sample")).status, "unavailable");
  assert.equal(await f.read(), null);
  const run = await f.claim(await f.start());
  await f.close();
  const db = new Database(resolve(f.root, "connections.sqlite"));
  const row = db
    .query<{ data: string }, [string]>(
      "SELECT document_json AS data FROM connection_checks WHERE id=?",
    )
    .get(run.id);
  db.close();
  assert.ok(row);
  assert.equal(
    connectionCheckResultSchema.shape.run
      .unwrap()
      .strip()
      .parse(JSON.parse(row.data) as unknown).status,
    "interrupted",
  );
});
