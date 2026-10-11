import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

void test("listing bookmarks, actions and shortlisted filtering stay together", () => {
  const result = Bun.spawnSync(
    [process.execPath, resolve(import.meta.dir, "helpers/listing-shortlist-ui.ts")],
    { cwd: resolve(import.meta.dir, ".."), timeout: 30000 },
  );
  assert.equal(result.exitCode, 0, result.stderr.toString() + result.stdout.toString());
});
