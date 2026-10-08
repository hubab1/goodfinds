import { Effect } from "effect";
import { seedWorkspace } from "./helpers/workspace.ts";
import { validateConfiguration } from "./reference-server/src/listings/evaluation.ts";
import { connect } from "./reference-server/src/platform/listing-evaluation-sqlite.ts";
import { saveConfiguration } from "./reference-server/src/platform/configuration-sqlite.ts";
import { revisionFor } from "./helpers/revisions.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { startPreview } from "@goodfinds/reference-server/preview";
import { stateFromToolResult } from "@goodfinds/contracts/state";

void test("the packaged protocol helper preserves the chosen workspace in its nested server", async (t) => {
  const folder = await mkdtemp(resolve(tmpdir(), "goodfinds-helper-workspace-"));
  t.after(async () => rm(folder, { recursive: true, force: true }));
  const config = z
    .object({ searches: z.array(z.object({ id: z.string(), name: z.string() }).loose()) })
    .loose()
    .parse(
      JSON.parse(
        await readFile(
          resolve("skills/marketplace-shopping/assets/example-workspace.json"),
          "utf8",
        ),
      ) as unknown,
    );
  const first = config.searches[0];
  assert.ok(first);
  config.searches = [{ ...first, id: "helper-fixture", name: "Helper fixture" }];
  const database = Effect.runSync(connect(resolve(folder, "workspace.sqlite")));
  Effect.runSync(saveConfiguration(database, Effect.runSync(validateConfiguration(config))));
  database.close();
  const child = Bun.spawn([resolve("dist/build/server/goodfinds"), "client"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: "", GOODFINDS_WORKSPACE_DIR: folder },
  });
  await child.stdin.write(
    JSON.stringify({ name: "get_goodfinds_search_context", arguments: {} }) + "\n",
  );
  await child.stdin.write(
    JSON.stringify({
      name: "request_goodfinds_search_run",
      arguments: { request: { search_id: "helper-fixture", request_id: crypto.randomUUID() } },
    }) + "\n",
  );
  await child.stdin.end();
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, errors);
  const replies = output
    .trim()
    .split("\n")
    .map((line) =>
      z
        .object({
          isError: z.boolean().optional(),
          structuredContent: z.record(z.string(), z.unknown()),
        })
        .parse(JSON.parse(line) as unknown),
    );
  assert.equal(replies.length, 2);
  assert.ok(replies.every((reply) => !reply.isError));
  const context = z
    .object({
      paths: z.object({ database: z.string() }),
      searches: z.array(z.object({ id: z.string() })),
    })
    .parse(replies[0]?.structuredContent);
  assert.equal(context.paths.database, resolve(folder, "workspace.sqlite"));
  assert.deepEqual(
    context.searches.map((search) => search.id),
    ["helper-fixture"],
  );
});

void test("the bundled panel includes React and shadcn without external assets", async () => {
  const html = await readFile(resolve("dist/build/web/panel.html"), "utf8");
  assert.match(html, /<script type="module">/);
  assert.match(html, /data-slot/);
  assert.match(html, /Good finds/);
  assert.doesNotMatch(html, /<(?:script|link)\b[^>]*(?:src|href)=/);
});

void test("installed-style stdio server advertises the panel and persists edits across clients", async (context) => {
  const data = await mkdtemp(resolve(tmpdir(), "goodfinds-mcp-"));
  seedWorkspace(data);
  const client = new Client({ name: "Goodfinds test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: resolve("dist/build/server/goodfinds"),
    args: [],
    env: { PATH: "", GOODFINDS_WORKSPACE_DIR: data },
  });
  context.after(async () => {
    await client.close();
    await rm(data, { recursive: true, force: true });
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.find((tool) => tool.name === "report_goodfinds_listing_contact"));
  const open = tools.find((tool) => tool.name === "open_goodfinds_panel");
  assert.ok(open);
  const meta = z
    .object({
      "openai/ui": z.object({ entrypoints: z.array(z.object({ type: z.string() })) }),
      ui: z.object({ resourceUri: z.string() }),
    })
    .parse(open._meta);
  assert.deepEqual(meta["openai/ui"].entrypoints, [{ type: "thread" }, { type: "global" }]);
  const resource = await client.readResource({ uri: meta.ui.resourceUri });
  const contents = z.object({ mimeType: z.string(), text: z.string() }).parse(resource.contents[0]);
  assert.equal(contents.mimeType, "text/html;profile=mcp-app");
  assert.ok(contents.text.includes("Goodfinds"));
  assert.ok(!contents.text.includes("__GOODFINDS_PREVIEW__={token:"));
  const current = stateFromToolResult(
    await client.callTool({ name: "get_goodfinds_workspace", arguments: {} }),
  );
  const first = current.config.searches[0];
  assert.ok(first);
  const search = { ...first, values: { ...first.values, max_price_minor: 100001 } };
  const changed = stateFromToolResult(
    await client.callTool({
      name: "save_goodfinds_search",
      arguments: {
        search,
        expected_entity_revision: revisionFor(current, "save_goodfinds_search", { search }),
      },
    }),
  );
  assert.equal(changed.searches[0]?.values["max_price_minor"], 100001);
  const reread = stateFromToolResult(
    await client.callTool({ name: "get_goodfinds_workspace", arguments: {} }),
  );
  assert.equal(reread.revision, changed.revision);
  const stale = await client.callTool({
    name: "save_goodfinds_search",
    arguments: {
      search,
      expected_entity_revision: revisionFor(current, "save_goodfinds_search", { search }),
    },
  });
  assert.equal(stale.isError, true);
  const invalid = await client.callTool({
    name: "save_goodfinds_search",
    arguments: {
      search: { ...search, values: { ...search.values, max_price_minor: -1 } },
      expected_entity_revision: revisionFor(changed, "save_goodfinds_search", {
        search: { ...search },
      }),
    },
  });
  assert.equal(invalid.isError, true);
  const sample = stateFromToolResult(
    await client.callTool({ name: "load_goodfinds_sample_workspace", arguments: {} }),
  );
  assert.equal(sample.counts.deals, 4);
  assert.equal(
    stateFromToolResult(await client.callTool({ name: "get_goodfinds_workspace", arguments: {} }))
      .counts.listings,
    0,
  );
});

void test("local panel serves only its own origin and rejects unauthenticated writes", async (context) => {
  const data = await mkdtemp(resolve(tmpdir(), "goodfinds-preview-"));
  const { http, url } = await startPreview(data);
  context.after(async () => {
    await new Promise<void>((done, reject) => {
      http.close((error) => {
        if (error) reject(error);
        else done();
      });
    });
    await rm(data, { recursive: true, force: true });
  });
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.ok(response.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"));
  const html = await response.text();
  const token = html.match(/token:"([a-f0-9]+)"/)?.[1];
  assert.ok(token);
  const call = { name: "get_goodfinds_workspace", arguments: {} };
  assert.equal(
    (await fetch(`${url}api/tool`, { method: "POST", body: JSON.stringify(call) })).status,
    404,
  );
  assert.equal(
    (
      await fetch(`${url}api/tool`, {
        method: "POST",
        headers: { "X-Goodfinds-Token": token, Origin: "https://example.com" },
        body: JSON.stringify(call),
      })
    ).status,
    403,
  );
  const good = await fetch(`${url}api/tool`, {
    method: "POST",
    headers: { "X-Goodfinds-Token": token },
    body: JSON.stringify(call),
  });
  assert.equal(stateFromToolResult(await good.json()).mode, "live");
});

void test("tracking imports preserve full purchase price and coverage through the MCP state contract", async (context) => {
  const data = await mkdtemp(resolve(tmpdir(), "goodfinds-tracking-mcp-"));
  seedWorkspace(data);
  const client = new Client({ name: "Tracking test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: resolve("dist/build/server/goodfinds"),
    args: [],
    env: { PATH: "", GOODFINDS_WORKSPACE_DIR: data },
  });
  context.after(async () => {
    await client.close();
    await rm(data, { recursive: true, force: true });
  });
  await client.connect(transport);
  const initial = stateFromToolResult(
    await client.callTool({ name: "get_goodfinds_workspace", arguments: {} }),
  );
  const search = initial.searches[0];
  assert.ok(search);
  const stamp = new Date().toISOString();
  const observation = {
    source: "autotrader",
    provenance: "manual",
    listing_id: "123456789012345",
    url: "https://www.autotrader.co.uk/car-details/123456789012345",
    product: "vehicle",
    title: "Outright-price fixture",
    price_kind: "finance",
    price_minor: 29900,
    finance_monthly_minor: 29900,
    cash_price_minor: 1200000,
    currency: "GBP",
    availability: "active",
    observed_at: stamp,
    evidence: { cash_price_minor: "Full purchase price £12,000; bank transfer accepted" },
    publication: {
      raw_text: "Publication not shown",
      precision: "unknown",
      kind: "unknown",
      earliest_at: null,
      latest_at: null,
    },
    terms: { payment_methods: ["bank_transfer"] },
  };
  const imported = stateFromToolResult(
    await client.callTool({
      name: "import_goodfinds_listing_observations",
      arguments: {
        observations: [observation],
        search_coverage: [
          {
            source: "autotrader",
            search_id: search.id,
            query: "fixture",
            filters: {},
            sort: "newest",
            started_at: stamp,
            finished_at: stamp,
            status: "partial",
            pagination_complete: false,
            result_count: null,
            inspected_count: 1,
          },
        ],
      },
    }),
  );
  assert.equal(imported.listings[0]?.price_minor, 1200000);
  assert.equal(imported.listings[0]?.source, "autotrader");
  assert.equal(imported.listings[0]?.["finance_monthly_minor"], undefined);
  assert.equal(imported.activity[0]?.status, "partial");
  assert.equal(imported.listings[0]?.events?.[0]?.kind, "first_observed_at");
  assert.equal(
    Date.parse(imported.listings[0]?.price_history[0]?.observed_at ?? ""),
    Date.parse(stamp),
  );
  const failed = stateFromToolResult(
    await client.callTool({
      name: "import_goodfinds_listing_observations",
      arguments: {
        observations: [
          {
            source: observation.source,
            provenance: "manual",
            listing_id: observation.listing_id,
            url: observation.url,
            observed_at: new Date().toISOString(),
            check_outcome: "not_found",
          },
        ],
      },
    }),
  );
  assert.equal(failed.listings[0]?.availability, "active");
  assert.equal(failed.listings[0]?.check_outcome, "not_found");
  assert.equal(failed.listings[0]?.quality?.eligibility["current_stock"]?.eligible, false);
});
