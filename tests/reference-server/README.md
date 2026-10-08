# TypeScript reference server

This private development package preserves the prior server as an executable reference for regression tests and contract export. It is not the production server and is not included in plugin archives.

Production behavior lives in `apps/server` as Rust. UI development connects to that native executable. Shared UI types, Zod schemas and tool definitions remain in `packages/contracts`; the native build embeds their generated JSON contracts.

Keep reference behavior stable when using it to check a native port. Intentional behavior changes need corresponding native tests and updated reference expectations. Passing reference tests alone does not establish that the native implementation behaves correctly: run the Rust suite and packaged executable smoke test too.
