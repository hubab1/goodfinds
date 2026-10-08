import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

void test(
  "seen status requires sustained visible exposure and keeps unseen results stable during receipt saves",
  { timeout: 15000 },
  () => {
    const result = Bun.spawnSync(
      [process.execPath, resolve(import.meta.dir, "helpers/listing-reading-ui.ts")],
      {
        cwd: resolve(import.meta.dir, ".."),
        timeout: 30000,
      },
    );
    assert.equal(result.exitCode, 0, result.stderr.toString() + result.stdout.toString());
  },
);
