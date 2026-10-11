import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

void test("stopped schedules are discoverable and wait for confirmed resumption", () => {
  const result = Bun.spawnSync(
    [process.execPath, resolve(import.meta.dir, "helpers/monitoring-ui.ts")],
    { cwd: resolve(import.meta.dir, ".."), timeout: 15000 },
  );
  assert.equal(result.exitCode, 0, result.stderr.toString() + result.stdout.toString());
});
