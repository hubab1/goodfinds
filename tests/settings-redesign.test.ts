import { seedWorkspace } from "./helpers/workspace.ts";
import { revisionFor } from "./helpers/revisions.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { WorkspaceStore } from "../apps/server/src/platform/workspace-sqlite.ts";
import { stateSchema } from "@goodfinds/contracts/state";
import { accessAvailable } from "@goodfinds/contracts/integrations";
import {
  deviceBrowserLabel,
  marketplaceConnection,
} from "../apps/ui/src/lib/settings-presentation.ts";

void test("selecting a device browser saves a preference without granting browser access", (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-settings-choice-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new WorkspaceStore(seedWorkspace(folder));
  const before = Effect.runSync(store.request("get_workspace")).state;
  const after = Effect.runSync(
    store.request("save_settings", {
      expected_entity_revision: revisionFor(before, "save_settings"),
      settings: { browser_preference: "external" },
    }),
  ).state;
  assert.equal(after.config.browser_preference, "external");
  assert.deepEqual(after.config.browser_access, []);
  assert.deepEqual(after.config.platform_sessions, []);
  assert.equal(
    accessAvailable(after.config.browser_access, "external", after.access_context, Date.now()),
    false,
  );
});

void test("saving unrelated preferences retains the confirmed location and its country", (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-settings-location-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new WorkspaceStore(seedWorkspace(folder));
  let state = Effect.runSync(store.request("get_workspace")).state;
  const location = {
    source: "manual",
    latitude: null,
    longitude: null,
    accuracy_m: null,
    area: "Manchester",
    country: "GB",
    acquired_at: new Date().toISOString(),
    display: "town",
  };
  state = Effect.runSync(
    store.request("save_settings", {
      expected_entity_revision: revisionFor(state, "save_settings"),
      settings: { location },
    }),
  ).state;
  for (const settings of [
    { browser_preference: "external" },
    { platforms: { ebay: { enabled: false, browser: "default" } } },
    { baseline_days: 60 },
  ]) {
    state = Effect.runSync(
      store.request("save_settings", {
        expected_entity_revision: revisionFor(state, "save_settings"),
        settings,
      }),
    ).state;
    assert.deepEqual(state.config.location, location);
    assert.equal(state.config.origin, "Manchester");
    assert.equal(state.config.origin_confirmed, true);
  }
});

void test("compact statuses follow the selected browser, account, website permission and current device identity", (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-settings-status-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const value = stateSchema.parse(
    Effect.runSync(new WorkspaceStore(seedWorkspace(folder)).request("get_workspace")).state,
  );
  const now = Date.now();
  const checked_at = new Date(now).toISOString();
  value.config.browser_preference = "external";
  value.device_browser = { id: "com.apple.Safari", name: "Safari" };
  value.config.browser_access = [
    {
      browser: "external",
      browser_id: "com.apple.Safari",
      status: "available",
      host: "Test host",
      profile: "Buyer",
      context_id: value.access_context,
      checked_at,
      evidence: "Observed supported browser",
      blocked_domains: [],
    },
  ];
  value.config.platform_sessions = [
    {
      marketplace: "facebook_marketplace",
      browser: "external",
      browser_id: "com.apple.Safari",
      status: "signed_in",
      host: "Test host",
      profile: "Buyer",
      context_id: value.access_context,
      checked_at,
      evidence: "Observed signed-in account",
    },
  ];
  assert.equal(deviceBrowserLabel(value), "Default browser (Safari)");
  assert.equal(marketplaceConnection(value, "facebook_marketplace", now), "Signed in");
  const access = value.config.browser_access[0];
  const session = value.config.platform_sessions[0];
  assert.ok(access && session);
  access.blocked_domains = ["facebook.com"];
  assert.equal(marketplaceConnection(value, "facebook_marketplace", now), "Unavailable");
  access.blocked_domains = [];
  session.profile = "Different buyer";
  assert.equal(marketplaceConnection(value, "facebook_marketplace", now), "Not checked");
  session.profile = "Buyer";
  session.status = "signed_out";
  assert.equal(marketplaceConnection(value, "facebook_marketplace", now), "Sign in");
  session.status = "signed_in";
  for (const delta of [-31 * 60_000, 60_000]) {
    session.checked_at = new Date(now + delta).toISOString();
    assert.equal(marketplaceConnection(value, "facebook_marketplace", now), "Check needed");
  }
  session.checked_at = checked_at;
  value.device_browser = { id: "com.google.Chrome", name: "Google Chrome" };
  assert.equal(marketplaceConnection(value, "facebook_marketplace", now), "Check needed");
  assert.equal(deviceBrowserLabel(value), "Default browser (Chrome)");
  value.config.platforms.facebook_marketplace = { enabled: false, browser: "default" };
  assert.equal(marketplaceConnection(value, "facebook_marketplace", now), "Off");
});
