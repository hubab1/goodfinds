import { seedWorkspace } from "./helpers/workspace.ts";
import { stateFromToolResult } from "@goodfinds/contracts/state";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { App } from "@modelcontextprotocol/ext-apps";
import { AppBridge, isToolVisibilityAppOnly } from "@modelcontextprotocol/ext-apps/app-bridge";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createGoodfindsServer } from "@goodfinds/server/mcp";
import {
  SEARCH_REQUEST,
  interviewRequest,
  searchRequest,
  sendSearchRequest,
  sendUserRequest,
} from "../apps/ui/src/lib/search.ts";
import { hostRequest, QUIET_BROWSING_GUIDANCE } from "@goodfinds/contracts/host-request";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { connectionCheckResultSchema } from "@goodfinds/contracts/connection-checks";
import { requestConnectionCheck } from "../apps/ui/src/lib/connection-checks.ts";

void test("Settings Check queues through MCP Apps and sends one delegation request before a worker claim", async (t) => {
  const data = await mkdtemp(resolve(tmpdir(), "goodfinds-check-bridge-"));
  const { server } = createGoodfindsServer(seedWorkspace(data));
  const client = new Client({ name: "Connection check host", version: "1.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const bridge = new AppBridge(
    client,
    { name: "Test host", version: "1.0.0" },
    { serverTools: {}, message: { text: {} } },
  );
  const messages: unknown[] = [];
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- AppBridge uses request handlers, not DOM events.
  bridge.onmessage = (message) => {
    messages.push(message);
    return Promise.resolve({});
  };
  const app = new App({ name: "Goodfinds", version: "0.11.0" }, {}, { autoResize: false });
  const [hostTransport, appTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await app.close();
    await bridge.close();
    await client.close();
    await server.close();
    await rm(data, { recursive: true, force: true });
  });
  await bridge.connect(hostTransport);
  await app.connect(appTransport);
  const state = stateFromToolResult(
    await client.callTool({ name: "get_goodfinds_workspace", arguments: {} }),
  );
  const result = await requestConnectionCheck(
    app,
    (name, args) => app.callServerTool({ name, arguments: args }),
    {
      mode: "live",
      request_id: randomUUID(),
      expected_entity_revision: state.revisions.settings,
    },
  );
  assert.ok(result.run);
  assert.equal(result.run.status, "queued");
  assert.equal(result.run.worker, null);
  assert.equal(messages.length, 1);
  const claimed = connectionCheckResultSchema.parse(
    (
      await client.callTool({
        name: "claim_goodfinds_connection_check",
        arguments: {
          mode: "live",
          run_id: result.run.id,
          expected_version: result.run.version,
          worker_id: randomUUID(),
          agent_id: "fixture-native-child",
          parent_thread_id: "fixture-parent",
        },
      })
    ).structuredContent,
  );
  assert.equal(claimed.run?.status, "running");
  const panel = connectionCheckResultSchema.parse(
    (
      await app.callServerTool({
        name: "get_goodfinds_connection_check",
        arguments: { mode: "live", run_id: result.run.id },
      })
    ).structuredContent,
  );
  assert.deepEqual(panel.run, claimed.run);
});

void test("MCP Apps handshake forwards a UI edit to the same state read by conversation tools", async (t) => {
  const data = await mkdtemp(resolve(tmpdir(), "goodfinds-bridge-"));
  const { server } = createGoodfindsServer(seedWorkspace(data));
  const client = new Client({ name: "UI test host", version: "1.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const bridge = new AppBridge(
    client,
    { name: "Test host", version: "1.0.0" },
    { serverTools: {}, logging: {} },
  );
  const app = new App({ name: "Goodfinds", version: "0.5.0" }, {}, { autoResize: false });
  const [hostTransport, appTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await app.close();
    await bridge.close();
    await client.close();
    await server.close();
    await rm(data, { recursive: true, force: true });
  });
  await bridge.connect(hostTransport);
  await app.connect(appTransport);
  assert.ok(client.getInstructions()?.endsWith(QUIET_BROWSING_GUIDANCE));
  const { tools } = await client.listTools();
  const imageTool = tools.find((tool) => tool.name === "get_goodfinds_image");
  assert.ok(imageTool);
  assert.equal(isToolVisibilityAppOnly(imageTool), false);
  assert.deepEqual(imageTool._meta?.["ui"], { visibility: ["model", "app"] });
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZioAAAAASUVORK5CYII=",
    "base64",
  );
  const path = resolve(data, "photo.png");
  await writeFile(path, bytes);
  const cached = CallToolResultSchema.parse(
    await client.callTool({
      name: "cache_goodfinds_images",
      arguments: { files: [{ path, label: "Listing photo" }] },
    }),
  );
  assert.ok(cached.content.every((block) => block.type === "text"));
  assert.ok(!JSON.stringify(cached).includes(bytes.toString("base64")));
  const media = z
    .object({ media: z.array(z.object({ id: z.string() })) })
    .parse(cached.structuredContent).media[0];
  assert.ok(media);
  const image = await app.callServerTool({
    name: "get_goodfinds_image",
    arguments: { media_id: media.id },
  });
  assert.deepEqual(image.content, [
    { type: "image", mimeType: "image/png", data: bytes.toString("base64") },
  ]);
  const videoTool = tools.find((tool) => tool.name === "get_goodfinds_video");
  assert.ok(videoTool);
  assert.equal(isToolVisibilityAppOnly(videoTool), true);
  const videoBytes = Buffer.from(
    "000000186674797069736f6d0000020069736f6d6d703432000000086d646174",
    "hex",
  );
  const videoPath = resolve(data, "video.mp4");
  await writeFile(videoPath, videoBytes);
  const cachedVideo = CallToolResultSchema.parse(
    await client.callTool({
      name: "cache_goodfinds_media",
      arguments: { files: [{ path: videoPath, label: "Seller video" }] },
    }),
  );
  assert.ok(!JSON.stringify(cachedVideo).includes(videoBytes.toString("base64")));
  const videoMedia = z
    .object({ media: z.array(z.object({ id: z.string() })) })
    .parse(cachedVideo.structuredContent).media[0];
  assert.ok(videoMedia);
  const video = await app.callServerTool({
    name: "get_goodfinds_video",
    arguments: { media_id: videoMedia.id },
  });
  assert.deepEqual(video.content, []);
  assert.deepEqual(video.structuredContent, {
    mime_type: "video/mp4",
    data: videoBytes.toString("base64"),
  });
  await assert.rejects(sendSearchRequest(app), /Automatic actions aren't available/);
  const stateResult = await app.callServerTool({ name: "get_goodfinds_workspace", arguments: {} });
  assert.ok(stateResult.content.every((block) => block.type === "text"));
  const before = stateFromToolResult(stateResult);
  const result = stateFromToolResult(
    await app.callServerTool({
      name: "save_goodfinds_settings",
      arguments: {
        expected_entity_revision: before.revisions.settings,
        settings: { interval_minutes: 90 },
      },
    }),
  );
  assert.equal(result.config.schedule.interval_minutes, 90);
  const fromChat = stateFromToolResult(
    await client.callTool({ name: "get_goodfinds_workspace", arguments: {} }),
  );
  assert.equal(fromChat.config.schedule.interval_minutes, 90);
  assert.equal(fromChat.revision, result.revision);
});

void test("Search now sends a user request to the host chat and reports host rejection", async (t) => {
  const data = await mkdtemp(resolve(tmpdir(), "goodfinds-search-"));
  const { server } = createGoodfindsServer(seedWorkspace(data));
  const client = new Client({ name: "UI test host", version: "1.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const bridge = new AppBridge(
    client,
    { name: "Test host", version: "1.0.0" },
    { message: { text: {} } },
  );
  const messages: { role: string; content: unknown }[] = [];
  let rejectRequest = false;
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- AppBridge uses request handlers, not DOM events.
  bridge.onmessage = async (message) => {
    messages.push(message);
    return rejectRequest ? { isError: true } : {};
  };
  const app = new App({ name: "Goodfinds", version: "0.5.0" }, {}, { autoResize: false });
  const [hostTransport, appTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await app.close();
    await bridge.close();
    await client.close();
    await server.close();
    await rm(data, { recursive: true, force: true });
  });
  await bridge.connect(hostTransport);
  await app.connect(appTransport);
  assert.equal(await sendSearchRequest(app), "sent");
  assert.deepEqual(messages, [{ role: "user", content: [{ type: "text", text: SEARCH_REQUEST }] }]);
  assert.equal(await sendSearchRequest(app, "mac-mini"), "sent");
  const selected = searchRequest("mac-mini");
  assert.match(selected, /only the saved search with ID "mac-mini"/);
  assert.match(selected, /enabled\/paused setting unchanged/);
  assert.match(selected, /native background subagents/);
  assert.match(selected, /Return promptly after dispatch/);
  assert.match(selected, /Reuse an already claimed active worker/);
  assert.deepEqual(messages[1], { role: "user", content: [{ type: "text", text: selected }] });
  assert.ok(selected.endsWith(QUIET_BROWSING_GUIDANCE));
  const interview = interviewRequest("Find a coffee machine");
  assert.ok(interview.endsWith(QUIET_BROWSING_GUIDANCE));
  assert.equal(hostRequest(interview), interview);
  const accessRequest = "Check my marketplace sign-in";
  assert.equal(await sendUserRequest(app, accessRequest), "sent");
  assert.deepEqual(messages[2], {
    role: "user",
    content: [{ type: "text", text: hostRequest(accessRequest) }],
  });
  assert.equal(await sendUserRequest(app, hostRequest(accessRequest)), "sent");
  assert.deepEqual(messages[3], messages[2]);
  rejectRequest = true;
  await assert.rejects(sendSearchRequest(app, "mac-mini"), /could not accept/);
});
