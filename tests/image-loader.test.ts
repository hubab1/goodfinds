import test from "node:test";
import assert from "node:assert/strict";
import { resolve as resolvePath } from "node:path";
import { createImageLoader } from "../apps/ui/src/lib/image-loader.ts";

void test("the panel accepts AVIF images served by the native media cache", () => {
  const result = Bun.spawnSync(
    [process.execPath, resolvePath(import.meta.dir, "helpers/image-client.ts")],
    {
      cwd: resolvePath(import.meta.dir, ".."),
      timeout: 10000,
    },
  );
  assert.equal(result.exitCode, 0, result.stderr.toString() + result.stdout.toString());
});

void test("gallery and prefetch share retries and a recovered original", async () => {
  let attempts = 0;
  const load = createImageLoader(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("Host request temporarily failed");
      return "saved original";
    },
    { pause: async () => undefined },
  );
  const prefetch = load("lead");
  const gallery = load("lead");
  assert.equal(prefetch, gallery);
  assert.deepEqual(await Promise.all([prefetch, gallery]), ["saved original", "saved original"]);
  assert.equal(attempts, 3);
  assert.equal(await load("lead"), "saved original");
  assert.equal(attempts, 3);
});

void test("a failed image can be retried without starving other gallery slots", async () => {
  let failing = true;
  let active = 0;
  let peak = 0;
  let badAttempts = 0;
  const load = createImageLoader(
    async (id) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        if (id === "bad" && failing) {
          badAttempts += 1;
          throw new Error("Unavailable");
        }
        return id;
      } finally {
        active -= 1;
      }
    },
    { concurrency: 2, pause: async () => undefined },
  );
  const results = await Promise.allSettled([load("bad"), ...["b", "c", "d", "e"].map(load)]);
  assert.equal(results[0]?.status, "rejected");
  assert.ok(results.slice(1).every((result) => result.status === "fulfilled"));
  assert.equal(badAttempts, 3);
  assert.equal(peak, 2);
  failing = false;
  assert.equal(await load("bad"), "bad");
});

void test("completed images have entry and byte bounds without evicting in-flight requests", async () => {
  const calls: string[] = [];
  let release: ((value: string) => void) | undefined;
  const load = createImageLoader(
    async (id) => {
      calls.push(id);
      if (id === "pending")
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      return id.repeat(4);
    },
    { maxEntries: 2, maxBytes: 16 },
  );
  const pending = load("pending");
  const visible = await load("a");
  await load("b");
  await load("a"); // Recently used a survives c.
  await load("c");
  assert.equal(load("pending"), pending);
  assert.equal(visible, "aaaa", "Eviction does not revoke a visible image");
  await load("a");
  assert.equal(calls.filter((id) => id === "a").length, 1);
  await load("b");
  assert.equal(calls.filter((id) => id === "b").length, 2);
  assert.ok(release);
  release("oversized image data");
  await pending;
  await load("huge");
  await load("huge");
  assert.equal(calls.filter((id) => id === "huge").length, 2, "Oversized entries are not retained");
});

void test("clearing cached workspace data prevents a late image from repopulating the cache", async () => {
  const resolvers: ((value: string) => void)[] = [];
  const load = createImageLoader(() => new Promise<string>((resolve) => resolvers.push(resolve)));
  const stale = load("same-id");
  load.clear();
  const current = load("same-id");
  assert.notEqual(current, stale);
  resolvers[0]?.("old bytes");
  await stale;
  assert.equal(load("same-id"), current);
  resolvers[1]?.("new bytes");
  await current;
  assert.equal(await load("same-id"), "new bytes");
});
