import { backupWorkspace, restoreWorkspace } from "../platform/backup.ts";
import { Clock, Effect, Cause } from "effect";
import { directory, readText, writeText, atomicJson } from "../platform/files.ts";
import { validation, storage } from "../workspace/errors.ts";
import { errorMessage } from "@goodfinds/contracts/state";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import exampleConfig from "../../../../skills/marketplace-shopping/assets/example-workspace.json" with { type: "json" };
import demoRows from "../../../../skills/marketplace-shopping/assets/demo-listings.json" with { type: "json" };
import { DAY, iso, parseJson } from "../workspace/model.ts";
import { all, get, close, transaction } from "../platform/sqlite.ts";
import { loadConfiguration } from "../platform/configuration-sqlite.ts";
import { validateConfiguration } from "../listings/evaluation.ts";
import {
  evaluateObservations,
  connect,
  acknowledge,
} from "../platform/listing-evaluation-sqlite.ts";
import { protocolCli } from "./protocol-cli.ts";
import { transport } from "../workspace/errors.ts";
import type { Alert, EvaluationResult } from "../listings/evaluation.ts";

function escape(value: unknown): string {
  const text = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}
function money(
  value: number | null | undefined,
  currency: string | null | undefined = "GBP",
): string {
  return value == null
    ? "Unknown price"
    : new Intl.NumberFormat("en-GB", { style: "currency", currency: currency ?? "GBP" }).format(
        value / (currency === "JPY" ? 1 : 100),
      );
}
export const renderReport = Effect.fn("renderReport")(function* (
  result: EvaluationResult,
  path: string,
) {
  const rows = result.searches
    .map(
      ({ search, decisions }) =>
        `<section><h2>${escape(search.name)}</h2><table><thead><tr><th>Listing</th><th>Asking price</th><th>Peer average</th><th>Decision</th></tr></thead><tbody>${decisions
          .toSorted(
            (a, b) => (a.listing.price_minor ?? Infinity) - (b.listing.price_minor ?? Infinity),
          )
          .map(
            (d) =>
              `<tr><td><a href="${escape(d.listing.url)}">${escape(d.listing.title)}</a><small>${escape(d.listing.description)}</small></td><td>${escape(money(d.listing.price_minor, d.listing.currency))}</td><td>${escape(d.reference_average_minor == null ? "—" : money(d.reference_average_minor, d.listing.currency))}<small>${d.peer_count ?? 0} peers</small></td><td>${escape(d.status)}<small>${escape(d.reasons.join("; "))}</small></td></tr>`,
          )
          .join("")}</tbody></table></section>`,
    )
    .join("");
  const cards =
    result.new_alerts
      .map(
        (alert) =>
          `<article><small>${escape(alert.search_name)} · ${escape(alert.kind.replaceAll("_", " "))}</small><h3><a href="${escape(alert.listing.url)}">${escape(alert.listing.title)}</a></h3><strong>${escape(money(alert.listing.price_minor))}</strong><p>${alert.percent_below_average}% below ${escape(money(alert.reference_average_minor))} average of ${alert.peer_count} peers.</p></article>`,
      )
      .join("") || "<p>No new alerts. Unchanged listings do not create another alert.</p>";
  const notice =
    result.mode === "synthetic"
      ? "Synthetic demonstration. Listings, sellers, prices and journey times are invented. No Facebook searches or notifications have been sent."
      : "Manually imported observations. No automatic browser search or notification delivery is implemented.";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Goodfinds · Saved search preview</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f5ef;color:#20372d;font:16px system-ui,sans-serif}main{max-width:1160px;margin:auto;padding:36px 24px}h1{font-size:40px}section,article{background:white;border:1px solid #e2e5da;border-radius:16px;padding:24px;margin:16px 0}table{border-collapse:collapse;width:100%;text-align:left}th,td{padding:14px;border-bottom:1px solid #eceee7;vertical-align:top}small{display:block;color:#607064;margin-top:6px}a{color:#244c3b}strong{font-size:28px}.notice{background:#fff3da;padding:18px;border-radius:12px}section{overflow:auto}table{min-width:650px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px}</style></head><body><main><h1>Your next good deal.</h1><p>${escape(result.origin)} · ${result.observed_count} listings observed · ${result.pending_alerts.length} awaiting delivery</p><p class="notice">${escape(notice)}</p><h2>New alert previews</h2><div class="cards">${cards}</div>${rows}<footer>Average = arithmetic mean of distinct, equivalent observed listings, excluding the candidate. Asking prices are not completed sale prices. Run: ${escape(result.evaluated_at)}</footer></main></body></html>`;
  yield* directory(dirname(path));
  yield* writeText(path, html);
});
export const runDemo = Effect.fn("runDemo")(function* (output: string, searches?: string) {
  yield* directory(output);
  const config = searches ? yield* readJson(searches) : exampleConfig;
  const normalized = yield* validateConfiguration(config);
  const now = yield* Clock.currentTimeMillis;
  const rows = demoRows.map((row) =>
    Object.assign({}, row, { drive_origin: normalized.origin, travel_checked_at: iso(now) }),
  );
  const folder = yield* Effect.acquireRelease(
    storage("create demo workspace", () => mkdtempSync(resolve(tmpdir(), "goodfinds-demo-"))),
    (path) =>
      storage("remove demo workspace", () => rmSync(path, { recursive: true, force: true })).pipe(
        Effect.orDie,
      ),
  );
  const db = resolve(folder, "workspace.sqlite");
  const first = yield* evaluateObservations(config, rows, db, true, now);
  const second = yield* evaluateObservations(config, rows, db, true, now + DAY / 1440);
  yield* renderReport(first, resolve(output, "first-run.html"));
  yield* renderReport(second, resolve(output, "second-run.html"));
  yield* writeText(resolve(output, "results.json"), JSON.stringify({ first, second }, null, 2));
  yield* storage("copy demo SQLite", () => copyFileSync(db, resolve(output, "demo.sqlite")));
  return {
    mode: "synthetic",
    first_run_new_alerts: first.new_alerts.length,
    second_run_new_alerts: second.new_alerts.length,
    pending_delivery: second.pending_alerts.length,
    first_report: resolve(output, "first-run.html"),
    second_report: resolve(output, "second-run.html"),
  };
}, Effect.scoped);
function readJson(path: string) {
  return readText(path).pipe(Effect.flatMap((text) => validation(() => parseJson<unknown>(text))));
}
const cliOptions = {
  output: { type: "string" },
  workspace: { type: "string" },
  observations: { type: "string" },
  db: { type: "string" },
  report: { type: "string" },
  "search-coverage": { type: "string" },
  ids: { type: "string", multiple: true },
  help: { type: "boolean" },
  input: { type: "string" },
} as const;
export const runCli = Effect.fn("runCli")(function* (argv: string[]) {
  const { values, positionals } = yield* validation(() =>
    parseArgs({ args: argv, allowPositionals: true, options: cliOptions }),
  );
  if (values.help) {
    yield* storage("write CLI output", () =>
      process.stdout.write(
        "Goodfinds: doctor | call TOOL --input FILE | client (JSON lines: name, arguments) | backup --db FILE --output NEW_DIR | restore --input BACKUP_DIR --output NEW_DIR | demo --output DIR [--workspace FILE] | export --db FILE --output FILE | evaluate --workspace FILE --observations FILE --db FILE [--report FILE] [--search-coverage FILE] | status --db FILE | ack --db FILE --ids ID [ID...]\n",
      ),
    );
    return;
  }
  const required = (name: "output" | "workspace" | "observations" | "db" | "input") =>
    validation(() => {
      const value = values[name];
      if (!value) throw new Error("--" + name + " is required");
      return value;
    });
  let result: unknown;
  switch (positionals[0]) {
    case "doctor":
    case "call":
    case "client":
      result = yield* transport(() =>
        protocolCli(positionals[0] ?? "doctor", positionals[1], values.input),
      );
      break;
    case "demo":
      result = yield* runDemo(yield* required("output"), values.workspace);
      break;
    case "backup":
      result = yield* backupWorkspace(yield* required("db"), yield* required("output"));
      break;
    case "restore":
      result = yield* restoreWorkspace(yield* required("input"), yield* required("output"));
      break;
    case "export": {
      const path = resolve(yield* required("db"));
      const output = resolve(yield* required("output"));
      yield* validation(() => {
        if (path === output) throw new Error("Export configuration to a separate JSON file");
      });
      const db = yield* Effect.acquireRelease(connect(path), close);
      const config = yield* transaction(db, loadConfiguration(db, "live"));
      yield* atomicJson(output, config);
      result = { database: path, config: output };
      break;
    }
    case "evaluate": {
      const evaluationResult = yield* evaluateObservations(
        yield* readJson(yield* required("workspace")),
        yield* readJson(yield* required("observations")),
        yield* required("db"),
        false,
        yield* Clock.currentTimeMillis,
        values["search-coverage"] ? yield* readJson(values["search-coverage"]) : null,
      );
      if (values.report) yield* renderReport(evaluationResult, values.report);
      result = evaluationResult;
      break;
    }
    case "ack": {
      const ids = [...(values.ids ?? []), ...positionals.slice(1)];
      yield* validation(() => {
        if (!ids.length) throw new Error("--ids is required");
      });
      result = { acknowledged: yield* acknowledge(yield* required("db"), ids) };
      break;
    }
    case "status": {
      const db = yield* Effect.acquireRelease(connect(yield* required("db")), close);
      result = {
        listing_evaluations:
          (yield* get<{ count: number }>(db, "SELECT COUNT(*) AS count FROM listing_evaluations"))
            ?.count ?? 0,
        listings: (yield* all<{ data: string }>(
          db,
          "SELECT listing_key AS key,provenance,document_json AS data,first_observed_at,last_observed_at FROM listings",
        )).map((row) => Object.assign({}, row, { data: parseJson<unknown>(row.data) })),
        pending_alerts: (yield* all<{ payload: string }>(
          db,
          "SELECT alert_json AS payload FROM deal_alerts WHERE status='pending'",
        )).map((row) => parseJson<Alert>(row.payload)),
      };
      break;
    }
    default:
      yield* validation(() => {
        throw new Error(
          "Choose backup, restore, demo, export, evaluateObservations, status or ack (use --help for usage)",
        );
      });
  }
  if (result === undefined) return;
  yield* storage("write CLI output", () =>
    process.stdout.write(JSON.stringify(result, null, 2) + "\n"),
  );
}, Effect.scoped);
// Promise boundary for the bundled skill helper; the CLI workflow itself remains an Effect.
export function runCliMain(argv: string[]): Promise<void> {
  return Effect.runPromise(
    runCli(argv).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          process.stderr.write(
            "Could not complete the request: " + errorMessage(Cause.squash(cause)) + "\n",
          );
          process.exitCode = 2;
        }),
      ),
    ),
  );
}
