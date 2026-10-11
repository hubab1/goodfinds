import { v0_3 } from "@anthropic-ai/mcpb/schemas";
import { executableName } from "./build-target.ts";
import type { BuildTarget } from "./build-target.ts";

export type PluginMetadata = { name: string; version: string; description: string };
export const pluginHosts = ["codex", "claude", "claude-desktop"] as const;
export type PluginHost = (typeof pluginHosts)[number];

export function claudePluginManifest(metadata: PluginMetadata) {
  return {
    ...metadata,
    author: { name: "Goodfinds development" },
    skills: "./skills/",
    mcpServers: "./.mcp.json",
  };
}

export function claudeServers(target: BuildTarget) {
  return {
    mcpServers: {
      goodfinds: {
        type: "stdio" as const,
        command: `\${CLAUDE_PLUGIN_ROOT}/server/${executableName(target)}`,
        args: [],
      },
    },
  };
}

export function desktopManifest(metadata: PluginMetadata, target: BuildTarget) {
  const platform = target.includes("apple")
    ? "darwin"
    : target.includes("windows")
      ? "win32"
      : "linux";
  // Validate against Anthropic's schema before writing or archiving the bundle.
  return v0_3.McpbManifestSchema.parse({
    manifest_version: "0.3",
    ...metadata,
    display_name: "Goodfinds",
    author: { name: "Goodfinds development" },
    icon: "assets/logo.png",
    long_description:
      `Find and compare marketplace listings with a local workspace and interactive panel. Built for ${target}. ` +
      "Browser actions and recurring checks require compatible host tools. Install the companion Claude plugin ZIP for the shopping skill.",
    server: {
      type: "binary",
      entry_point: `server/${executableName(target)}`,
      mcp_config: {
        command: `\${__dirname}/server/${executableName(target)}`,
        args: [],
        env: { GOODFINDS_WORKSPACE_DIR: "${user_config.workspace_directory}" },
      },
    },
    tools_generated: true,
    compatibility: { platforms: [platform] },
    user_config: {
      workspace_directory: {
        type: "directory",
        title: "Goodfinds workspace",
        description:
          "Where Goodfinds saves searches, listings and media. Use the same folder as Codex to share your workspace, or choose a separate test folder.",
        required: false,
        default: "${HOME}/.local/share/goodfinds",
      },
    },
  });
}
