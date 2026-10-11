import test from "node:test";
import assert from "node:assert/strict";
import { v0_3 } from "@anthropic-ai/mcpb/schemas";
import { supportedBuildTargets, executableName } from "../scripts/build-target.ts";
import { claudePluginManifest, claudeServers, desktopManifest } from "../scripts/plugin-formats.ts";

const metadata = { name: "goodfinds-marketplace", version: "0.1.0", description: "Find listings" };

void test("Claude packages use install-relative native commands for every supported target", () => {
  for (const target of supportedBuildTargets) {
    const plugin = claudeServers(target).mcpServers.goodfinds;
    const desktop = desktopManifest(metadata, target);
    assert.ok(v0_3.McpbManifestSchema.safeParse(desktop).success);
    assert.equal(plugin.command, `\${CLAUDE_PLUGIN_ROOT}/server/${executableName(target)}`);
    assert.equal(
      desktop.server.mcp_config?.command,
      `\${__dirname}/server/${executableName(target)}`,
    );
    assert.equal(desktop.server.entry_point, `server/${executableName(target)}`);
    assert.equal(desktop.server.type, "binary");
    assert.deepEqual(desktop.compatibility?.platforms, [
      target.includes("apple") ? "darwin" : target.includes("windows") ? "win32" : "linux",
    ]);
    assert.equal(desktop.compatibility?.runtimes, undefined);
    for (const field of ["cwd", "env_vars"]) assert.equal(field in plugin, false);
  }
  assert.equal(claudePluginManifest(metadata).mcpServers, "./.mcp.json");
});

void test("desktop installs can use persistent workspaces outside the versioned package", () => {
  const manifest = desktopManifest(metadata, "aarch64-apple-darwin");
  assert.equal(
    manifest.user_config?.["workspace_directory"]?.default,
    "${HOME}/.local/share/goodfinds",
  );
  assert.equal(
    manifest.server.mcp_config?.env?.["GOODFINDS_WORKSPACE_DIR"],
    "${user_config.workspace_directory}",
  );
});
