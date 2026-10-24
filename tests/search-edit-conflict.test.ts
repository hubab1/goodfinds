import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

void test("search edits recover stale revisions without overwriting newer changes", () => {
  const result = Bun.spawnSync(
    [process.execPath, resolve(import.meta.dir, "helpers/search-edit-conflict.ts")],
    { cwd: resolve(import.meta.dir, ".."), timeout: 120000 },
  );
  assert.equal(result.exitCode, 0, result.stderr.toString() + result.stdout.toString());
});
