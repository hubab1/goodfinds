import test from "node:test";
import assert from "node:assert/strict";
import { createImageLoader } from "../apps/ui/src/lib/image-loader.ts";

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
