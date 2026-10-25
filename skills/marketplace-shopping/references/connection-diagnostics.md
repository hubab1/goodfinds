# Connection diagnostics and fallback

Discover enabled Goodfinds tools first. A visible skill does not prove its MCP server is mounted. If tools are absent, run from the installed plugin root:

```sh
/absolute/plugin/root/server/goodfinds doctor
```

The doctor starts a real stdio connection, lists tools, reads the panel resource and compact context. It does not prove native-question support or host mounting. Check the plugin connection error, manifest command, executable permissions, operating system/CPU compatibility and working directory; refresh the plugin connection after installing/updating. Preserve existing data. Do not reset configuration solely because tools are absent.

An existing chat can retain the previous server and tool schemas after its installed files change. If mounted capabilities disagree with the installed helper, record that mismatch and use the current helper for affected operations. After the host refreshes the plugin, recheck mounted capabilities and read its current context before returning to native tools. Reuse saved runs and observations; a refresh does not authorize duplicate searches.

For an authorized reliability repair, distinguish source changes, the installed executable and the server already mounted in the chat. A passing branch test or open PR does not update the installed plugin. Build and validate the repaired package, preserve a rollback copy, verify the installed executable against the build, and exercise the affected operation through that executable. If the host retains the old process, use the current packaged helper for affected operations and keep that instruction in the existing automation until a refreshed mount is verified. Keep search preferences, data, accounts and unrelated schedules intact.

If a fresh chat still lacks tools after the doctor passes, report that the packaged server is healthy but the host has not exposed it. Check the host's plugin loader instead of repeating the reinstall advice. The desktop app can bundle a different Codex version from the executable on PATH. An enabled skill or plugin entry does not establish that its MCP server was discovered.

When only some tools are exposed, use the packaged helper for the missing operation; existing successful reads do not require a new diagnostic cycle. Inspect its complete input schema before the first write:

```sh
/absolute/plugin/root/server/goodfinds schema save_goodfinds_search
```

This is read-only and returns the actual embedded schema. Mutation probes with empty arguments only produce validation errors. Save JSON arguments to a file and use `call TOOL --input FILE` for independent setup writes and search-run actions. Search request/claim/renew/progress/import guards use durable run IDs, worker IDs and versions, so those calls can use separate helper invocations. Check `isError` and unwrap `structuredContent` before using the result; a successful process exit alone does not prove a successful tool call. Keep request UUIDs stable on retries.

For repeated collection calls, reuse the parsed schemas and one small call wrapper. Retain full receipts in audit files when needed, but return only the fields being checked, listing keys, media IDs and errors to the model. Reading both the serialized text and duplicate `structuredContent` adds work without another verification. Expand a full response only to investigate a specific discrepancy.

A persistent client is required for related browser-access reports, connection checks and seller actions that share an `access_context`. When a persistent JavaScript runtime is available, spawn one helper there with ordinary pipes. For these context-bound operations, use:

```sh
/absolute/plugin/root/server/goodfinds client
```

Send one JSON line per request, e.g. `{"name":"get_goodfinds_search_context","arguments":{"mode":"live"}}`. Use ordinary pipes, not a PTY: terminal line limits can corrupt large JSON and response chunks are not message boundaries. Buffer until a complete newline-delimited response arrives before sending the next request. Keep the process alive across related calls: one MCP session preserves access_context identity and the same validation/send-action safeguards. Output is compact. Native forms are unavailable here; resume the saved interview in chat/panel. A single independent call can use `call TOOL --input /absolute/arguments.json`. Do not mix access reports from separate short-lived sessions.

Some terminal tools close stdin for noninteractive commands. If `write_stdin` reports a closed stream, keep the client inside a small local subprocess wrapper that owns its ordinary stdin/stdout pipes and buffers complete responses. Use a local queue for subsequent requests if needed. A PTY is not a safe workaround for large JSON. Prefer mounted tools again once the host exposes the current schemas.

Development: `bun run package` builds a platform-specific package containing a standalone Rust executable with the panel and search covers embedded. `bun scripts/smoke-plugin.ts dist/goodfinds-marketplace` checks both manifests, launches with an empty PATH, runs the doctor from a relocated copy of just the executable, and reads tools/resource/context and embedded search covers. No Bun or Node installation is needed to run the package. Run `bun scripts/check-plugin-host.ts dist/goodfinds-marketplace /absolute/path/to/desktop/codex` to check discovery through the actual desktop loader in an isolated marketplace. Keep portable launch fields in `mcp.json`; Codex-specific `cwd` and `env_vars` belong to the Codex launch configuration. These checks are separate from opening the connected panel in a live host chat.

Run native helper commands through the host shell tool. Keep browser REPL code focused on its documented browser and file APIs; it may not provide process globals or permit importing `node:process`.
