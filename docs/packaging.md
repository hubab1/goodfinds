# Building and distributing Goodfinds

Installed plugins run one native Rust executable. SQLite, the UI, tool schemas and built-in media are compiled into that executable. Buyers do not need Bun, Node.js, Rust, SQLite or a package manager. The UI still runs JavaScript in the host's web view; it communicates with the server through the existing MCP contracts.

Source builds require Bun for the UI and contract generator, a Rust toolchain, and a C compiler for bundled SQLite. Windows builds need the Visual C++ build tools and Windows SDK. Unix packaging uses `zip`; Windows packaging uses PowerShell. These are development requirements only.

```sh
bun install --frozen-lockfile
bun run package
bun scripts/smoke-plugin.ts
```

Packaging builds the UI and native contracts before compiling the release executable. Each ZIP contains one target and records its Rust target triple in its filename and `server/build.json`. `GOODFINDS_BUILD_TARGET` selects a different target:

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

The smoke test copies only the executable to a temporary directory and starts it with an empty `PATH`. It verifies the native doctor command, MCP tool and UI resources, embedded images, clean live workspaces, and workflow guards. Source build dependencies and adjacent repository files cannot satisfy that test.

[Native CI](../.github/workflows/native.yml) builds and tests the current architecture of GitHub's Linux, macOS and Windows runners, then uploads each ZIP as a workflow artifact. It does not publish a release or establish coverage for other CPU architectures.
