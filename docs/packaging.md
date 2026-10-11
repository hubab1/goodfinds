# Building and distributing Goodfinds

Installed plugins run one native Rust executable. SQLite, the UI, tool schemas and built-in media are compiled into that executable. Buyers do not need Bun, Node.js, Rust, SQLite or a package manager. The UI still runs JavaScript in the host's web view; it communicates with the server through the existing MCP contracts.

Source builds require Bun for the UI and contract generator, a Rust toolchain, and a C compiler for bundled SQLite. Windows builds need the Visual C++ build tools and Windows SDK. Unix packaging uses `zip`; Windows packaging uses PowerShell. These are development requirements only.

```sh
bun install --frozen-lockfile
bun run package
bun run package:check
```

Packaging builds the UI and native contracts before compiling the release executable once. It emits separate Codex and Claude plugin ZIPs plus a Claude Desktop MCP bundle (`.mcpb`). Each archive contains one target and records its Rust target triple in its filename and `server/build.json`. `GOODFINDS_BUILD_TARGET` selects a different target:

| System      | CPU              | Target                       |
| ----------- | ---------------- | ---------------------------- |
| macOS       | Apple silicon    | `aarch64-apple-darwin`       |
| macOS       | Intel            | `x86_64-apple-darwin`        |
| Windows     | Intel/AMD 64-bit | `x86_64-pc-windows-msvc`     |
| Windows     | ARM64            | `aarch64-pc-windows-msvc`    |
| Linux       | Intel/AMD 64-bit | `x86_64-unknown-linux-gnu`   |
| Linux       | ARM64            | `aarch64-unknown-linux-gnu`  |
| Linux, musl | Intel/AMD 64-bit | `x86_64-unknown-linux-musl`  |
| Linux, musl | ARM64            | `aarch64-unknown-linux-musl` |

```sh
rustup target add x86_64-apple-darwin
GOODFINDS_BUILD_TARGET=x86_64-apple-darwin bun run package
```

A Rust target supplies the standard library; cross-compiling also requires a compatible linker, platform SDK and C compiler for SQLite. Build on the matching operating system when those tools are unavailable. The target list describes supported build configuration, not a claim that every target has passed release validation. Run the package smoke test on each target before distributing it.

The default Linux build uses the GNU ABI and depends on the target system's compatible C library. Choose a musl target when producing a Linux executable without that dependency. Windows builds request a static C runtime. macOS and Windows executables still use their operating system's libraries and APIs.

Release builds remap the build machine's home and repository paths in compiler diagnostics and panic metadata. The build rejects an executable that still contains either absolute path. Existing `CARGO_ENCODED_RUSTFLAGS` or `RUSTFLAGS` are retained, following Cargo's precedence rules.

There is no single executable that runs across macOS, Windows and Linux. The scripts produce separate archives, with `goodfinds.exe` in Windows packages. A universal macOS executable requires separately compiled Apple silicon and Intel slices; the current packaging scripts do not combine them. Release hosting should offer the appropriate archive for each supported target.

## Choose the host package

**Codex:** extract `goodfinds-marketplace-<version>-codex-<target>.zip` and load it through local plugin support. The unpacked build remains at `dist/goodfinds-marketplace`. Its `.codex-plugin/plugin.json` points to `.mcp.json`, which retains Codex's `cwd` and environment forwarding. `plugin.json` and `mcp.json` remain available for portable hosts. The source checkout's Codex manifests are also refreshed by packaging.

**Claude Code:** extract `goodfinds-marketplace-<version>-claude-<target>.zip`, or use the unpacked build:

```sh
claude --plugin-dir /absolute/path/to/dist/goodfinds-marketplace-claude
```

The archive has `.claude-plugin/plugin.json`, the shopping skill, and a standard stdio `.mcp.json`. Its command uses `${CLAUDE_PLUGIN_ROOT}` so it works from any working directory, including install paths containing spaces. It has no Codex-only launch fields. For Claude's account plugin UI, upload this ZIP through **Customize → Plugins**. Claude's current documentation says plugin-local servers run in Cowork and Claude Code, while Chat requires a separate local connection. An OS-specific binary must match the environment executing it; a macOS build is not a Linux Cowork build. Do not infer Cowork compatibility from a successful Desktop Chat test.

**Claude Desktop Chat:** choose the matching `goodfinds-marketplace-<version>-claude-desktop-<target>.mcpb`. Open **Settings → Extensions → Advanced settings → Install extension**, select the file, and configure the workspace folder. The bundle's `manifest.json` is validated against Anthropic's pinned MCPB schema during packaging. It launches the same native server through `${__dirname}` and requires no language runtime. The MCPB connects tools and panel resources; install the companion Claude plugin ZIP through Customize for the shopping skill. Open a fresh chat after installation.

Desktop extensions default to `${HOME}/.local/share/goodfinds`, matching Codex. Choose a separate folder when testing to keep fixture data isolated. Changing hosts does not migrate or erase data. Reinstalling an updated bundle preserves the configured external workspace. MCPB platform compatibility specifies the OS; users must still choose the CPU/ABI in the filename. Producing a Linux MCPB does not claim that Claude Desktop is available on Linux.

Claude Desktop Chat supports the panel and saved shopping data, but does not run plugin subagents. Goodfinds currently requires native background workers and compatible browser controls for Facebook Marketplace discovery, so installing both Chat packages does not make live searches available there. Cowork requires a paid Claude plan; verify its server execution environment and browser access before promising discovery. Claude Code also needs its own working browser route. A queued run with no worker and no query activity is a failed search-initiation test, not a successful search.

Collection model overrides fall back to the host's current model when unavailable. Do not claim a connection check, search or schedule succeeded without the corresponding host capability and observed result. Never activate real marketplace monitoring or contact sellers as an installation test. A buyer-authorized one-off live test should save the one-off preference, leave recurring monitoring off, and record an actual blocker if no worker can launch.

Formats and install behavior follow [Anthropic's MCPB specification](https://github.com/anthropics/mcpb/blob/main/MANIFEST.md), [Claude's plugin reference](https://code.claude.com/docs/en/plugins-reference), [Desktop extension installation](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop), [plugin support by Claude surface](https://support.claude.com/en/articles/13837440-use-plugins-in-claude), and [Cowork requirements](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork).

## Validate the archives

`bun run package:check` extracts all three actual archives to temporary folders with spaces in their paths and runs the same smoke suite against each host's manifest. Claude launches from an unrelated working directory. The test also copies only the executable to another temporary directory and runs its doctor command with an empty `PATH`. It verifies MCP tools and UI resources, embedded images, clean live workspaces, and workflow guards. Source dependencies and adjacent repository files cannot satisfy that standalone test. Test data stays in temporary workspaces.

For a single unpacked build, use `bun scripts/smoke-plugin.ts <directory> <host>`, where host is `codex`, `claude` or `claude-desktop`. The default remains `dist/goodfinds-marketplace codex`. Protocol smoke checks are separate from testing the real host UI. In Claude Desktop, verify the extension is enabled, invoke its tools in a fresh chat, and open the panel; use a separate workspace for edits.

[Native CI](../.github/workflows/native.yml) builds and tests the current architecture of GitHub's Linux, macOS and Windows runners, then validates and uploads both ZIP formats and the MCPB as workflow artifacts. It does not publish a release or establish coverage for other CPU architectures or live desktop hosts.
