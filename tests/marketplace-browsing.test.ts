import { nativeBinary } from "./helpers/native-driver.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { marketplaceCapabilitiesResultSchema } from "@goodfinds/contracts/external-tools";
import { queryPlan } from "@goodfinds/contracts/search-workflow";

void test("car and clothing briefs retain broad coverage when it shares the model query", () => {
  for (const [product, reference, exact] of [
    ["car", "Ford Focus", "Ford Focus 2018 automatic"],
    ["clothing", "J.Crew hoodie", "J.Crew hoodie XXL"],
  ] as const) {
    const queries = queryPlan({
      id: "audit",
      product,
      definition: { title: reference },
      marketplaces: ["gumtree", "vinted"],
      discovery: {
        reference_model: reference,
        category_terms: [reference],
        query_plan: [
          { text: exact, purpose: "exact" },
          { text: reference, purpose: "category" },
        ],
      },
    });
    for (const marketplace of ["gumtree", "vinted"]) {
      const scoped = queries.filter((query) => query.marketplace === marketplace);
      assert.equal(scoped.filter((query) => query.text === reference).length, 1);
      assert.equal(scoped.find((query) => query.text === reference)?.purpose, "category");
      assert.equal(scoped.find((query) => query.text === exact)?.purpose, "exact");
    }
  }
});

void test(
  `native advertises browser browsing without eBay API tools or credentials`,
  { timeout: 30000 },
  async (t) => {
    const folder = await mkdtemp(resolve(tmpdir(), "goodfinds-browser-routes-"));
    const client = new Client({ name: "Browser route test", version: "1" });
    t.after(async () => {
      await client.close();
      await rm(folder, { recursive: true, force: true });
    });
    await client.connect(
      new StdioClientTransport({
        command: nativeBinary,
        args: [],
        env: { PATH: "", GOODFINDS_WORKSPACE_DIR: folder },
      }),
    );
    const { tools } = await client.listTools();
    assert.equal(
      tools.some((tool) => /(?:search_goodfinds_ebay|get_goodfinds_ebay_listing)/u.test(tool.name)),
      false,
    );
    const reply = await client.callTool({
      name: "list_goodfinds_marketplace_capabilities",
      arguments: {},
    });
    assert.equal(reply.isError, undefined);
    const { result } = marketplaceCapabilitiesResultSchema.parse(reply.structuredContent);
    assert.equal("ebay_api_configured" in result, false);
    for (const marketplace of result.marketplaces)
      assert.equal(marketplace.route, "Browser search");
    assert.deepEqual(result.message_execution, ["facebook_marketplace"]);
    assert.deepEqual(result.native_offer_execution, []);
  },
);
