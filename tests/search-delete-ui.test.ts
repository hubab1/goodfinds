import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

void test("search deletion supports confirmation, schedules and deleting the final search", () => {
  const result = Bun.spawnSync(
    [process.execPath, resolve(import.meta.dir, "helpers/search-delete-ui.ts")],
    { cwd: resolve(import.meta.dir, ".."), timeout: 30000 },
  );
  assert.equal(result.exitCode, 0, result.stderr.toString() + result.stdout.toString());
});
