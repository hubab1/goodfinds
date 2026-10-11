# Coordination measurements

Set `GOODFINDS_DIAGNOSTICS=1` on the native server to emit one JSON line per workspace operation to stderr. MCP stdout remains reserved for protocol messages. Diagnostics contain operation names, success/error codes, durations, resource bytes and work counters, without arguments, listing content, identities or messages. Leave the variable unset to disable recording.

The recorded stages distinguish workspace opening, transaction lock wait, configuration reload, transaction lifetime, commit, listing loading and snapshot construction. Stage timings overlap; do not add them together. `elapsed_ms` covers the domain call, while `result_bytes` counts its serialized internal resource (including panel metadata when present). These are not model-token counts or end-to-end browser/host latency.

Use the isolated synthetic fixture:

```sh
cargo run --profile test-support --features test-support --manifest-path apps/server/Cargo.toml --example coordination-benchmark -- 0 10 20
```

Each size uses a temporary workspace, retains a fixed search and worker, warms one renewal, then reports 11 samples with p50, p95, transaction p95, bytes and work counters. The fixture duplicates a comparable listing to stress panel evaluation; it does not model a representative inventory. The unoptimized test-support build and host load affect timings. Compare the same fixture and build profile serially, without concurrent builds or tests; use larger sizes only after checking runtime. Do not interpret a small synthetic sample as production throughput.

## Recorded synthetic comparison

On 11 October 2026, the same fixture ran serially against the instrumented pre-change binary and the updated binary, using the unoptimized test-support profile. No other Goodfinds builds or tests ran during this comparison. Each row contains 11 warmed renewal samples.

| Listings | Before p50 / p95     | After p50 / p95 | Before / after transaction p95 | Before / after resource bytes |
| -------- | -------------------- | --------------- | ------------------------------ | ----------------------------- |
| 0        | 40.4 / 41.8 ms       | 25.5 / 27.6 ms  | 32.4 / 17.9 ms                 | 38,924 / 12,539               |
| 10       | 611.9 / 620.5 ms     | 24.7 / 25.3 ms  | 611.4 / 16.3 ms                | 99,274 / 12,539               |
| 20       | 1,964.9 / 1,990.2 ms | 24.9 / 26.3 ms  | 1,981.5 / 16.5 ms              | 161,305 / 12,539              |

Before the change, every renewal built one snapshot and loaded every fixture listing. Afterward, both counters remained zero at every size. This establishes removal of that work in the measured path. The duplicate-heavy, small fixture does not establish production latency or throughput.

## Regression budgets

Regression budgets assert work rather than wall time:

- Heartbeats and active progress updates perform zero full snapshots and zero listing loads while retaining run guards.
- Recovery and completion-feed reads perform zero full snapshots and return bounded pages with explicit cursors or offsets. Subsequent recovery pages pin both run and context revisions.
- Listing pages retain the full relevant current peer population while omitting historical observations, activity and market-history analysis. Listing detail loads only the requested observation history. Global identity relationships and recommendation ordering remain intact.
- Panel polling compares content revisions. Lease-only changes update version/owner metadata without triggering full evaluation; visible progress, new results and terminal transitions still refresh it.

Full panel rendering, terminal search completion and evidence imports still have broader work. Workspace opening still performs its existing initialization and configuration transactions. These measurements make those remaining costs visible rather than relaxing their correctness checks.
