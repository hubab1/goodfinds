import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

void test("exclusion clicks explain unknown models and keep listing versus model scope", () => {
  const result = Bun.spawnSync(
    [process.execPath, resolve(import.meta.dir, "helpers/listing-disregard-ui.ts")],
    { cwd: resolve(import.meta.dir, "..") },
  );
  assert.equal(result.exitCode, 0, result.stderr.toString() + result.stdout.toString());
});
