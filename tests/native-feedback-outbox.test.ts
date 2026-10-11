import { nativeBinary } from "./helpers/native-driver.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { feedbackEventSchema } from "@goodfinds/contracts/discovery";
import { stateFromToolResult } from "@goodfinds/contracts/state";

const feedbackResult = z.object({
  structuredContent: z.object({
    feedback: feedbackEventSchema,
    receipt: z.object({ request_id: z.uuid(), replayed: z.boolean() }),
  }),
});
void test("native MCP feedback receipts keep identity across retries, Undo and server restart", async (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-native-outbox-"));
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    rmSync(folder, { recursive: true, force: true });
  });
  const connect = async () => {
    const client = new Client({ name: "Native outbox test", version: "0.1.0" });
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: nativeBinary,
        env: { PATH: "", GOODFINDS_WORKSPACE_DIR: folder },
      }),
    );
    return client;
  };
  const client = await connect();
  const initial = stateFromToolResult(
    await client.callTool({ name: "load_goodfinds_sample_workspace", arguments: {} }),
  );
  assert.ok(initial.workspace_id);
  const search = initial.searches[0];
  assert.ok(search);
  const listing = initial.listings.find((row) => row.product === search.product);
  assert.ok(listing);
  const args = {
    mode: "sample",
    request_id: crypto.randomUUID(),
    expected_entity_revision: initial.revisions.absent,
    feedback: {
      search_id: search.id,
      listing_key: listing.key,
      action: "dismiss",
      scope: "search",
      reason: "Too expensive",
    },
  };
  const first = await client.callTool({
    name: "record_goodfinds_listing_feedback",
    arguments: args,
  });
  const event = feedbackResult.parse(first).structuredContent.feedback;
  assert.equal(event.request_id, args.request_id);
  assert.equal(event.reason, "Too expensive");
  assert.equal(event.rule, undefined);
  const replay = await client.callTool({
    name: "record_goodfinds_listing_feedback",
    arguments: args,
  });
  const parsed = feedbackResult.parse(replay).structuredContent;
  assert.equal(parsed.receipt.replayed, true);
  assert.equal(parsed.feedback.id, event.id);
  assert.equal(stateFromToolResult(replay).config.feedback.length, 1);
  const undo = await client.callTool({
    name: "undo_goodfinds_listing_feedback",
    arguments: {
      mode: "sample",
      request_id: crypto.randomUUID(),
      feedback_id: event.id,
      expected_entity_revision: stateFromToolResult(replay).revisions.feedback[event.id],
    },
  });
  assert.equal(
    stateFromToolResult(undo).config.feedback.find((item) => item.id === event.id)?.undone,
    true,
  );
  await client.close();
  const restarted = await connect();
  const afterRestart = await restarted.callTool({
    name: "record_goodfinds_listing_feedback",
    arguments: args,
  });
  const fresh = stateFromToolResult(afterRestart);
  assert.equal(fresh.workspace_id, initial.workspace_id);
  assert.notEqual(fresh.access_context, initial.access_context);
  assert.equal(feedbackResult.parse(afterRestart).structuredContent.feedback.id, event.id);
  assert.equal(fresh.config.feedback.length, 1);
  assert.equal(fresh.config.feedback[0]?.undone, true);
});
