import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createNativeServer, nativeOptions } from "./native-mcp.ts";
import { seedWorkspace } from "./workspace.ts";
import { stateFromToolResult } from "@goodfinds/contracts/state";
import { z } from "zod";

const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-search-edit-"));
const { server, calls } = createNativeServer(seedWorkspace(folder), nativeOptions(folder));
const dom = new Window({ url: "https://panel.example" });
Object.defineProperty(globalThis, "window", { value: dom, configurable: true });
Object.assign(dom, { __GOODFINDS_PREVIEW__: { token: "fixture-token" } });
const originalFetch = globalThis.fetch;
const requests: { name: string; arguments: Record<string, unknown> }[] = [];
const relay: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = async (
  _url,
  init,
) => {
  const body = init?.body;
  assert.ok(typeof body === "string");
  const input = z
    .object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) })
    .parse(JSON.parse(body) as unknown);
  requests.push(input);
  const handler = calls.get(input.name);
  assert.ok(handler, input.name);
  return Response.json(await handler(input.arguments));
};
globalThis.fetch = Object.assign(relay, { preconnect: originalFetch.preconnect });
const { invoke } = await import("../../apps/ui/src/lib/client.ts");
const call = async (name: string, args: Record<string, unknown>) => {
  const handler = calls.get(name);
  assert.ok(handler, name);
  const result = await handler(args);
  assert.ok(!result.isError, JSON.stringify(result));
  return stateFromToolResult(result);
};
try {
  const opened = await invoke("get_goodfinds_workspace", {});
  const search = opened.config.searches[0];
  assert.ok(search);
  const paused = await call("set_goodfinds_search_enabled", {
    search_id: search.id,
    enabled: false,
    expected_entity_revision: opened.revisions.searches[search.id],
    request_id: crypto.randomUUID(),
  });
  const saved = await invoke("save_goodfinds_search", {
    snapshot_revision: opened.revision,
    search: { ...search, name: "Updated buying brief" },
  });
  const changed = saved.config.searches.find((item) => item.id === search.id);
  assert.equal(changed?.name, "Updated buying brief");
  assert.equal(changed.enabled, false, "Saving an old form must preserve the newer pause");
  const saves = requests.filter((request) => request.name === "save_goodfinds_search");
  assert.equal(saves.length, 2, "Refresh and retry one confirmed revision conflict");
  assert.equal(
    saves[1]?.arguments["expected_entity_revision"],
    paused.revisions.searches[search.id],
  );
  assert.notEqual(saves[0]?.arguments["request_id"], saves[1]?.arguments["request_id"]);

  const editing = await invoke("get_goodfinds_workspace", {});
  const base = editing.config.searches.find((item) => item.id === search.id);
  assert.ok(base);
  const concurrent = await call("save_goodfinds_search", {
    search: { ...base, name: "Changed elsewhere" },
    expected_entity_revision: editing.revisions.searches[search.id],
    request_id: crypto.randomUUID(),
  });
  await assert.rejects(
    invoke("save_goodfinds_search", {
      snapshot_revision: editing.revision,
      search: { ...base, name: "My unsaved name" },
    }),
    /changed.*editing|changed.*elsewhere/i,
    "Conflicting edits need a readable error and must never be overwritten",
  );
  const after = await invoke("get_goodfinds_workspace", {});
  assert.equal(
    after.config.searches.find((item) => item.id === search.id)?.name,
    "Changed elsewhere",
  );
  assert.equal(after.revisions.searches[search.id], concurrent.revisions.searches[search.id]);
} finally {
  globalThis.fetch = originalFetch;
  await server.close();
  rmSync(folder, { recursive: true, force: true });
  await dom.happyDOM.close();
}
