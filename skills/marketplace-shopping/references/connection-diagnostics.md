# Connection diagnostics and fallback

Discover enabled Goodfinds tools first. A visible skill does not prove its MCP server is mounted. If tools are absent, run from the installed plugin root:

```sh
/absolute/plugin/root/server/goodfinds doctor
```

The doctor starts a real stdio connection, lists tools, reads the panel resource and compact context. It does not prove native-question support or host mounting. Check the plugin connection error, manifest command, executable permissions, operating system/CPU compatibility and working directory; open a fresh chat after installing/updating. Preserve existing data. Do not reset configuration solely because tools are absent.

If a fresh chat still lacks tools after the doctor passes, report that the packaged server is healthy but the host has not exposed it. Check the host's plugin loader instead of repeating the reinstall advice. The desktop app can bundle a different Codex version from the executable on PATH. An enabled skill or plugin entry does not establish that its MCP server was discovered.

To continue authorized work before the host connection is available:

```sh
/absolute/plugin/root/server/goodfinds client
```

Send one JSON line per request, e.g. `{"name":"get_goodfinds_search_context","arguments":{"mode":"live"}}`. Keep the process alive across related calls: one MCP session preserves access_context identity and the same validation/send-action safeguards. Output is compact. Native forms are unavailable here; resume the saved interview in chat/panel. A single independent call can use `call TOOL --input /absolute/arguments.json`. Do not mix access reports from separate short-lived sessions.

Development: `bun run package` builds a platform-specific package containing a standalone executable with Bun, the panel and search covers embedded. `bun scripts/smoke-plugin.ts dist/goodfinds-marketplace` checks both manifests, launches with an empty PATH, runs the doctor from a relocated copy of just the executable, and reads tools/resource/context and embedded search covers. No Bun or Node installation is needed to run the package. Run `bun scripts/check-plugin-host.ts dist/goodfinds-marketplace /absolute/path/to/desktop/codex` to check discovery through the actual desktop loader in an isolated marketplace. Keep portable launch fields in `mcp.json`; Codex-specific `cwd` and `env_vars` belong to the Codex launch configuration. These checks are separate from opening the connected panel in a live host chat.
