import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Cause, Clock, Effect, Exit, Layer } from "effect";
import { WorkspaceStore } from "../apps/server/src/platform/workspace-sqlite.ts";
import {
  all,
  close,
  execute,
  openDatabase,
  transaction,
} from "../apps/server/src/platform/sqlite.ts";
import { atomicJson } from "../apps/server/src/platform/files.ts";
import { RevisionConflict, StorageError } from "../apps/server/src/workspace/errors.ts";
import { Backend } from "../apps/server/src/entrypoints/backend.ts";
import { createGoodfindsServer } from "@goodfinds/server/mcp";
import { startPreview } from "@goodfinds/server/preview";

const fixedTime = Date.parse("2026-10-04T12:00:00Z");
const clock: Clock.Clock = {
  currentTimeMillisUnsafe: () => fixedTime,
  currentTimeMillis: Effect.succeed(fixedTime),
  currentTimeNanosUnsafe: () => BigInt(fixedTime) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(fixedTime) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => 0n,
  monotonicTimeNanos: Effect.succeed(0n),
  sleep: () => Effect.void,
};

void test("storage programs are lazy and the supplied Effect clock reaches transactions", (t) => {
  const base = mkdtempSync(resolve(tmpdir(), "goodfinds-effect-lazy-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const folder = resolve(base, "workspace");
  const store = new WorkspaceStore(folder);
  const program = store.request("get_workspace");
  assert.equal(existsSync(folder), false);
  const result = Effect.runSync(program.pipe(Effect.provideService(Clock.Clock, clock)));
  assert.equal(result.state.generated_at, new Date(fixedTime).toISOString());
  assert.equal(existsSync(store.databasePath), true);
  const conflict = Effect.runSyncExit(
    store.request("save_settings", {
      expected_entity_revision: "0".repeat(64),
      settings: { origin: "Elsewhere" },
    }),
  );
  assert.ok(Exit.isFailure(conflict));
  assert.ok(Cause.squash(conflict.cause) instanceof RevisionConflict);
  assert.equal(
    Effect.runSync(store.request("get_workspace")).state.revision,
    result.state.revision,
  );
});

void test("SQLite transactions roll back typed failures, defects and nested writes", (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-effect-rollback-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const db = Effect.runSync(openDatabase(resolve(folder, "test.sqlite")));
  t.after(() => Effect.runSync(close(db)));
  Effect.runSync(execute(db, "CREATE TABLE test (value INTEGER)"));
  const conflict = new RevisionConflict({ message: "Concurrent edit" });
  const failure = Effect.runSyncExit(
    transaction(
      db,
      Effect.gen(function* () {
        yield* execute(db, "INSERT INTO test VALUES (1)");
        yield* transaction(db, execute(db, "INSERT INTO test VALUES (2)"));
        return yield* Effect.fail(conflict);
      }),
    ),
  );
  assert.ok(Exit.isFailure(failure));
  assert.equal(Cause.squash(failure.cause), conflict);
  assert.equal(Effect.runSync(all(db, "SELECT * FROM test")).length, 0);
  const defect = new Error("Unexpected failure");
  const died = Effect.runSyncExit(
    transaction(
      db,
      execute(db, "INSERT INTO test VALUES (3)").pipe(Effect.andThen(Effect.die(defect))),
    ),
  );
  assert.ok(Exit.isFailure(died));
  assert.equal(Cause.squash(died.cause), defect);
  assert.equal(Effect.runSync(all(db, "SELECT * FROM test")).length, 0);
  Effect.runSync(transaction(db, execute(db, "INSERT INTO test VALUES (4)")));
  assert.deepEqual(Effect.runSync(all(db, "SELECT * FROM test")), [{ value: 4 }]);
});

void test("SQLite refuses asynchronous transaction work without committing later writes", async (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-effect-sync-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const db = Effect.runSync(openDatabase(resolve(folder, "test.sqlite")));
  t.after(() => Effect.runSync(close(db)));
  Effect.runSync(execute(db, "CREATE TABLE test (value INTEGER)"));
  const outcome = Effect.runSyncExit(
    transaction(
      db,
      Effect.gen(function* () {
        yield* execute(db, "INSERT INTO test VALUES (1)");
        yield* Effect.sleep("10 millis");
        yield* execute(db, "INSERT INTO test VALUES (2)");
      }),
    ),
  );
  assert.ok(Exit.isFailure(outcome));
  await Effect.runPromise(Effect.sleep("30 millis"));
  assert.equal(Effect.runSync(all(db, "SELECT * FROM test")).length, 0);
});

void test("failed atomic configuration writes preserve the file and remove staging files", (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-effect-atomic-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = resolve(folder, "searches.json");
  writeFileSync(path, '{"origin":"Original"}\n');
  const value: { self?: unknown } = {};
  value.self = value;
  const outcome = Effect.runSyncExit(atomicJson(path, value));
  assert.ok(Exit.isFailure(outcome));
  assert.ok(Cause.squash(outcome.cause) instanceof StorageError);
  assert.equal(readFileSync(path, "utf8"), '{"origin":"Original"}\n');
  assert.deepEqual(readdirSync(folder), ["searches.json"]);
});

function waitingBackend(start: () => void, release: () => void) {
  return Layer.succeed(Backend, {
    query: () => Effect.never,
    request: () =>
      Effect.scoped(
        Effect.acquireRelease(Effect.sync(start), () => Effect.sync(release)).pipe(
          Effect.andThen(Effect.never),
        ),
      ),
    cacheImages: () => Effect.never,
    cacheMedia: () => Effect.never,
    readVideo: () => Effect.never,
    readMediaFile: () => Effect.never,
    readImage: () => Effect.never,
    validateImages: () => Effect.void,
    panel: Effect.never,
  });
}
void test("MCP cancellation interrupts an Effect workflow and runs its finalizers", async (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-effect-cancel-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  let released = false;
  let notifyStarted: (() => void) | undefined;
  const started = new Promise<void>((resolveStarted) => {
    notifyStarted = resolveStarted;
  });
  const { server, calls } = createGoodfindsServer(
    folder,
    waitingBackend(
      () => notifyStarted?.(),
      () => {
        released = true;
      },
    ),
  );
  t.after(() => server.close());
  const call = calls.get("get_goodfinds_workspace");
  assert.ok(call);
  const controller = new AbortController();
  const result = call({}, controller.signal);
  // Observe rejection immediately, before interrupting the workflow.
  const rejected = assert.rejects(result);
  await started;
  controller.abort();
  await rejected;
  assert.equal(released, true);
});
void test("closing the MCP server interrupts outstanding work and disposes its Layer", async (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-effect-close-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  let released = false;
  let layerReleased = false;
  let notifyStarted: (() => void) | undefined;
  const started = new Promise<void>((resolveStarted) => {
    notifyStarted = resolveStarted;
  });
  const layer = waitingBackend(
    () => notifyStarted?.(),
    () => {
      released = true;
    },
  ).pipe(
    Layer.provide(
      Layer.effectDiscard(
        Effect.addFinalizer(() =>
          Effect.sync(() => {
            layerReleased = true;
          }),
        ),
      ),
    ),
  );
  const { server, calls } = createGoodfindsServer(folder, layer);
  const call = calls.get("get_goodfinds_workspace");
  assert.ok(call);
  const result = assert.rejects(call({}));
  await started;
  await server.close();
  await result;
  assert.equal(released, true);
  assert.equal(layerReleased, true);
  await server.close();
});
void test("preview startup rejects an occupied port and releases its resources", async (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-effect-port-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const first = await startPreview(folder, 0);
  t.after(() => Effect.runPromise(first.shutdown));
  const port = Number(new URL(first.url).port);
  await assert.rejects(startPreview(folder, port), /EADDRINUSE|(?:address|port).*use/iu);
  assert.equal((await fetch(first.url)).status, 200);
});

void test("the bundled runner reports CLI failures without writing protocol output", async () => {
  const child = Bun.spawn([resolve("dist/build/server/goodfinds"), "evaluate"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.equal(await child.exited, 2);
  assert.equal(await new Response(child.stdout).text(), "");
  assert.match(await new Response(child.stderr).text(), /--workspace is required/u);
});

void test("the bundled preview closes its port on SIGTERM after scoped shutdown", async (t) => {
  const child = Bun.spawn([resolve("dist/build/server/goodfinds"), "--preview"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GOODFINDS_PORT: "0" },
  });
  t.after(() => child.kill());
  const reader = child.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  const output = new TextDecoder().decode(first.value);
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+\//u)?.[0];
  assert.ok(url);
  assert.equal((await fetch(url)).status, 200);
  child.kill("SIGTERM");
  assert.equal(await child.exited, 130);
  assert.equal(await new Response(child.stderr).text(), "");
  await assert.rejects(fetch(url));
});

void test("the bundled stdio runner completes when its input stream closes", async (t) => {
  const child = Bun.spawn([resolve("dist/build/server/goodfinds")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  t.after(() => child.kill());
  await child.stdin.end();
  assert.equal(await child.exited, 0);
  assert.equal(await new Response(child.stdout).text(), "");
  assert.equal(await new Response(child.stderr).text(), "");
});
