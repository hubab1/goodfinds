import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

void test("panel opens the requested search, preserves navigation during refresh, and stops cleanly", () => {
  const result = Bun.spawnSync(
    [process.execPath, resolve(import.meta.dir, "helpers/panel-handoff-ui.ts")],
    { cwd: resolve(import.meta.dir, ".."), timeout: 15000 },
  );
  assert.equal(result.exitCode, 0, result.stderr.toString() + result.stdout.toString());
});
