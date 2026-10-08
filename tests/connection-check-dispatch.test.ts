import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connectionCheckRunSchema } from "@goodfinds/contracts/connection-checks";
import { executionPolicy } from "@goodfinds/contracts/worker-execution";
import { requestConnectionCheck } from "../apps/ui/src/lib/connection-checks.ts";

function fixture() {
  const stamp = new Date().toISOString();
  let run = connectionCheckRunSchema.parse({
    id: randomUUID(),
    request_id: randomUUID(),
    context_id: "connected-host",
    status: "queued",
    message: "Waiting…",
    created_at: stamp,
    updated_at: stamp,
    targets: [
      { marketplace: "facebook_marketplace", browser: "external", browser_id: "device-default" },
    ],
    results: [],
  });
  const messages: unknown[] = [];
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const app = {
    getHostCapabilities: () => ({ message: { text: {} } }),
    sendMessage: async (message: unknown) => {
      messages.push(message);
      return {};
    },
  };
  const call = (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "interrupt_goodfinds_connection_check") {
      assert.equal(args["expected_version"], run.version);
      assert.equal(run.status, "queued");
      run = {
        ...run,
        status: "unavailable",
        version: run.version + 1,
        message: String(args["reason"]),
      };
    }
    return Promise.resolve({
      structuredContent: { run, execution: executionPolicy("collection") },
    });
  };
  const args = { mode: "live", request_id: run.request_id, expected_entity_revision: "settings" };
  return {
    app,
    call,
    args,
    calls,
    messages,
    setStatus: (status: typeof run.status) => {
      run = { ...run, status, version: run.version + 1 };
    },
  };
}

void test("a queued check requests native delegation and remains queued until a worker claims it", async () => {
  const f = fixture();
  const result = await requestConnectionCheck(f.app, f.call, f.args);
  assert.equal(result.run?.status, "queued");
  assert.equal(f.messages.length, 1);
  const prompt = JSON.stringify(f.messages[0]);
  assert.match(prompt, /native background subagent/);
  assert.match(prompt, /claim this exact check/);
  assert.match(prompt, /Return promptly after dispatch/);
  assert.match(prompt, /Do not browse in the main chat/);
  assert.match(prompt, /gpt-6-luna/);
  assert.equal(f.calls.length, 1);
});

void test("a host without chat messaging cannot queue a check it cannot dispatch", async () => {
  const f = fixture();
  await assert.rejects(
    requestConnectionCheck({ ...f.app, getHostCapabilities: () => ({}) }, f.call, f.args),
    /Automatic actions/,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.messages.length, 0);
});

void test("host rejection records unavailable delegation on an unclaimed check", async () => {
  const f = fixture();
  const result = await requestConnectionCheck(
    { ...f.app, sendMessage: () => Promise.resolve({ isError: true }) },
    f.call,
    f.args,
  );
  assert.equal(result.run?.status, "unavailable");
  assert.deepEqual(result.run?.results, []);
  assert.deepEqual(
    f.calls.map((call) => call.name),
    [
      "start_goodfinds_connection_check",
      "get_goodfinds_connection_check",
      "interrupt_goodfinds_connection_check",
    ],
  );
});

void test("a failed host response cannot overwrite a raced worker claim or cancellation", async () => {
  await Promise.all(
    (["running", "cancelled"] as const).map(async (status) => {
      const f = fixture();
      const result = await requestConnectionCheck(
        {
          ...f.app,
          sendMessage: () => {
            f.setStatus(status);
            return Promise.reject(new Error("Response lost"));
          },
        },
        f.call,
        f.args,
      );
      assert.equal(result.run?.status, status);
      assert.equal(
        f.calls.some((call) => call.name === "interrupt_goodfinds_connection_check"),
        false,
      );
    }),
  );
});

void test("an already running check is reused without another dispatch message", async () => {
  const f = fixture();
  f.setStatus("running");
  assert.equal((await requestConnectionCheck(f.app, f.call, f.args)).run?.status, "running");
  assert.equal(f.messages.length, 0);
});
