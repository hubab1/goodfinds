import { nativeBinary } from "./helpers/native-driver.ts";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { startPreview } from "./helpers/native-preview.ts";

function processEnvironment(t: TestContext) {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-native-process-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return {
    ...process.env,
    GOODFINDS_WORKSPACE_DIR: folder,
    GOODFINDS_TEST_AUTOMATIONS: "",
    GOODFINDS_TEST_BROWSER: "null",
  };
}
void test("preview startup rejects an occupied port and releases its resources", async (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-effect-port-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const first = await startPreview(folder, 0);
  t.after(() => Effect.runPromise(first.shutdown));
  const port = Number(new URL(first.url).port);
  await assert.rejects(startPreview(folder, port), /EADDRINUSE|(?:address|port).*use/iu);
  assert.equal((await fetch(first.url)).status, 200);
});

void test("the bundled runner reports CLI failures without writing protocol output", async (t) => {
  const child = Bun.spawn([nativeBinary, "evaluate"], {
    env: processEnvironment(t),
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.equal(await child.exited, 2);
  assert.equal(await new Response(child.stdout).text(), "");
  assert.match(await new Response(child.stderr).text(), /--workspace is required/u);
});

void test("the bundled preview closes its port on SIGTERM after scoped shutdown", async (t) => {
  const child = Bun.spawn([nativeBinary, "--preview"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...processEnvironment(t), GOODFINDS_PORT: "0" },
  });
  t.after(() => child.kill());
  const reader = child.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  const output = new TextDecoder().decode(first.value);
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+\//u)?.[0];
  assert.ok(url);
  assert.equal((await fetch(url)).status, 200);
  child.kill("SIGTERM");
  assert.equal(await child.exited, 130);
  assert.equal(await new Response(child.stderr).text(), "");
  await assert.rejects(fetch(url));
});

void test("the bundled stdio runner completes when its input stream closes", async (t) => {
  const child = Bun.spawn([nativeBinary], {
    env: processEnvironment(t),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  t.after(() => child.kill());
  await child.stdin.end();
  assert.equal(await child.exited, 0);
  assert.equal(await new Response(child.stdout).text(), "");
  assert.equal(await new Response(child.stderr).text(), "");
});
