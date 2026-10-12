import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

void test("a failed saved cover is visible and can be retried", () => {
  const result = Bun.spawnSync(
    [process.execPath, resolve(import.meta.dir, "helpers/search-cover-ui.ts")],
    { cwd: resolve(import.meta.dir, ".."), timeout: 25000 },
  );
  assert.equal(result.exitCode, 0, result.stderr.toString() + result.stdout.toString());
});
