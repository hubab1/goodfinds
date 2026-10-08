import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

void test("dialogs support layered Escape, focus return, mobile sheets and native form submission", () => {
  const result = Bun.spawnSync(
    [process.execPath, resolve(import.meta.dir, "helpers/dialog-ux.ts")],
    { cwd: resolve(import.meta.dir, ".."), timeout: 30000 },
  );
  assert.equal(result.exitCode, 0, result.stderr.toString() + result.stdout.toString());
});
