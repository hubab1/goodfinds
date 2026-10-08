import type { CheckRecord } from "./model.ts";
import type { ConnectionCheckStorage, ConnectionCheckTransaction } from "./repository.ts";
import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import { MARKETPLACES } from "@goodfinds/contracts/integrations";
import {
  cancelConnectionCheckSchema,
  claimConnectionCheckSchema,
  completeConnectionCheckSchema,
  connectionCheckActive,
  connectionCheckRunSchema,
  interruptConnectionCheckSchema,
  readConnectionCheckSchema,
  renewConnectionCheckSchema,
  startConnectionCheckSchema,
  CONNECTION_CHECK_DISPATCH_MS,
  CONNECTION_CHECK_LEASE_MS,
  CONNECTION_CHECK_TIMEOUT_MS,
} from "@goodfinds/contracts/connection-checks";
import type {
  ConnectionCheckObservation,
  ConnectionCheckResult,
  ConnectionCheckTarget,
} from "@goodfinds/contracts/connection-checks";
import { executionPolicy } from "@goodfinds/contracts/worker-execution";
import type { GoodfindsState, WorkspaceMode } from "@goodfinds/contracts/state";
import { RevisionConflict, ValidationError } from "../workspace/errors.ts";

type Ports = {
  readState: (mode: WorkspaceMode) => Promise<GoodfindsState>;
  // Run the guard inside the workspace's writer transaction before applying
  // evidence. A cancellation accepted during an earlier await wins.
  record: (
    observations: readonly ConnectionCheckObservation[],
    state: GoodfindsState,
    mode: WorkspaceMode,
    signal: AbortSignal,
    guard: (config: GoodfindsState["config"]) => void,
  ) => Promise<GoodfindsState>;
};

function targetsFor(
  state: GoodfindsState,
  marketplaces?: z.infer<typeof startConnectionCheckSchema>["marketplaces"],
): ConnectionCheckTarget[] {
  const requested = marketplaces ? new Set(marketplaces) : null;
  const platforms = MARKETPLACES.filter((platform) => {
    if (requested && !requested.has(platform.id)) return false;
    if (state.config.platforms[platform.id]?.enabled === false) {
      if (requested) throw new ValidationError({ message: "Enable this marketplace first." });
      return false;
    }
    return true;
  });
  if (!platforms.length) throw new ValidationError({ message: "Choose a marketplace to check." });
  return platforms.map((platform) => {
    const saved = state.config.platforms[platform.id]?.browser ?? "default";
    const browser = saved === "default" ? state.config.browser_preference : saved;
    return {
      marketplace: platform.id,
      browser,
      browser_id: browser === "in_app" ? "iab" : (state.device_browser?.id ?? null),
    };
  });
}
function scopeOf(context: string, targets: readonly ConnectionCheckTarget[]): string {
  return createHash("sha256").update(JSON.stringify({ context, targets })).digest("hex");
}
function result(run: CheckRecord | null): ConnectionCheckResult {
  return {
    run: run ? connectionCheckRunSchema.strip().parse(run) : null,
    execution: executionPolicy("collection"),
  };
}

/** Owns durable check coordination and evidence validation; the host owns agents. */
export class ConnectionChecks {
  private readonly owner_process_id = randomUUID();
  private readonly committing = new Map<string, AbortController>();
  private closed = false;
  private readonly storage: ConnectionCheckStorage;
  private readonly ports: Ports;
  private readonly now: () => number;

  constructor(storage: ConnectionCheckStorage, ports: Ports, now: () => number = Date.now) {
    this.storage = storage;
    this.ports = ports;
    this.now = now;
  }

  private updated(run: CheckRecord, patch: Partial<CheckRecord>): CheckRecord {
    return {
      ...run,
      ...patch,
      version: run.version + 1,
      updated_at: new Date(this.now()).toISOString(),
    };
  }

  private recover(db: ConnectionCheckTransaction): void {
    for (const run of db.active()) {
      const started = Date.parse(run.worker?.claimed_at ?? run.created_at);
      if (
        run.lease_expires_at_ms <= this.now() ||
        (run.status === "running" && started + CONNECTION_CHECK_TIMEOUT_MS <= this.now())
      ) {
        db.save(
          this.updated(run, {
            status: "interrupted",
            message:
              run.status === "queued"
                ? "No background worker started. Try again."
                : "Check stopped or timed out. Try again.",
            lease_expires_at_ms: 0,
          }),
        );
        this.committing.get(run.id)?.abort();
      }
    }
  }

  private find(db: ConnectionCheckTransaction, context: string, id?: string): CheckRecord | null {
    this.recover(db);
    return db.find(context, id);
  }

  private require(run: CheckRecord | null): CheckRecord {
    if (!run)
      throw new ValidationError({
        message: "Read the check in its original Goodfinds connection.",
      });
    return run;
  }

  private change(
    mode: WorkspaceMode,
    context: string,
    id: string,
    update: (run: CheckRecord) => CheckRecord,
  ): CheckRecord {
    return this.storage.transaction(mode, (db) => {
      const run = this.require(this.find(db, context, id));
      const next = update(run);
      if (next !== run) db.save(next);
      return next;
    });
  }

  private version(run: CheckRecord, expected: number): void {
    if (run.version !== expected)
      throw new RevisionConflict({ message: "Check progress changed. Read it and retry." });
  }

  private owns(run: CheckRecord, workerId: string): void {
    if (this.closed || run.status !== "running" || run.worker?.id !== workerId)
      throw new ValidationError({
        message: "This worker no longer owns an active check. Stop browsing.",
      });
  }

  private scope(run: CheckRecord, state: GoodfindsState): void {
    if (
      state.mode === "sample" ||
      state.access_context !== run.context_id ||
      scopeOf(
        state.access_context,
        targetsFor(
          state,
          run.targets.map((target) => target.marketplace),
        ),
      ) !== run.target_scope_hash
    )
      throw new ValidationError({ message: "Browser selection changed. Start a new check." });
  }

  async start(input: unknown): Promise<ConnectionCheckResult> {
    const args = startConnectionCheckSchema.parse(input);
    const state = await this.ports.readState(args.mode);
    const selected = args.marketplaces ? [...new Set(args.marketplaces)].toSorted() : null;
    return this.storage.transaction(args.mode, (db) => {
      this.recover(db);
      const existing = db.findRequest(args.request_id);
      if (existing) {
        if (
          existing.context_id !== state.access_context ||
          JSON.stringify(existing.input_marketplaces) !== JSON.stringify(selected)
        )
          throw new ValidationError({ message: "Start a new check for this selection." });
        return result(existing);
      }
      if (state.revisions.settings !== args.expected_entity_revision)
        throw new RevisionConflict({ message: "Settings changed. Refresh and try again." });
      const targets = targetsFor(state, args.marketplaces);
      const scope = scopeOf(state.access_context, targets);
      const duplicate = db.findActive(state.access_context, scope);
      if (duplicate) return result(duplicate);
      const available = !this.closed && args.mode === "live";
      const stamp = new Date(this.now()).toISOString();
      const run: CheckRecord = {
        id: randomUUID(),
        request_id: args.request_id,
        version: 1,
        context_id: state.access_context,
        input_marketplaces: selected,
        target_scope_hash: scope,
        owner_process_id: this.owner_process_id,
        lease_expires_at_ms: available ? this.now() + CONNECTION_CHECK_DISPATCH_MS : 0,
        status: available ? "queued" : "unavailable",
        worker: null,
        message:
          args.mode === "sample"
            ? "Try this with your saved searches."
            : available
              ? "Waiting for a background check…"
              : "Check stopped. Try again.",
        created_at: stamp,
        updated_at: stamp,
        targets,
        results: [],
      };
      db.save(run);
      return result(run);
    });
  }

  async read(input: unknown): Promise<ConnectionCheckResult> {
    const args = readConnectionCheckSchema.parse(input);
    const state = await this.ports.readState(args.mode);
    return this.storage.transaction(args.mode, (db) =>
      result(this.find(db, state.access_context, args.run_id)),
    );
  }

  async claim(input: unknown): Promise<ConnectionCheckResult> {
    const args = claimConnectionCheckSchema.parse(input);
    const state = await this.ports.readState(args.mode);
    return result(
      this.change(args.mode, state.access_context, args.run_id, (run) => {
        this.scope(run, state);
        if (
          run.status === "running" &&
          run.worker?.id === args.worker_id &&
          run.worker.agent_id === args.agent_id
        ) {
          this.owns(run, args.worker_id);
          return run;
        }
        this.version(run, args.expected_version);
        if (this.closed || run.status !== "queued")
          throw new ValidationError({
            message: "This check cannot be claimed. Read its current progress.",
          });
        if (args.agent_id === args.parent_thread_id)
          throw new ValidationError({ message: "Delegate the check to a native subagent." });
        const stamp = new Date(this.now()).toISOString();
        return this.updated(run, {
          status: "running",
          message: "Checking…",
          lease_expires_at_ms: this.now() + CONNECTION_CHECK_LEASE_MS,
          worker: {
            id: args.worker_id,
            agent_id: args.agent_id,
            claimed_at: stamp,
            last_heartbeat_at: stamp,
            ...(args.parent_thread_id ? { parent_thread_id: args.parent_thread_id } : {}),
            ...(args.execution ? { execution: args.execution } : {}),
          },
        });
      }),
    );
  }

  async renew(input: unknown): Promise<ConnectionCheckResult> {
    const args = renewConnectionCheckSchema.parse(input);
    const state = await this.ports.readState(args.mode);
    return result(
      this.change(args.mode, state.access_context, args.run_id, (run) => {
        this.owns(run, args.worker_id);
        this.scope(run, state);
        const worker = run.worker;
        if (!worker) throw new ValidationError({ message: "A worker claim is required." });
        return this.updated(run, {
          lease_expires_at_ms: this.now() + CONNECTION_CHECK_LEASE_MS,
          worker: { ...worker, last_heartbeat_at: new Date(this.now()).toISOString() },
        });
      }),
    );
  }

  async interrupt(input: unknown): Promise<ConnectionCheckResult> {
    const args = interruptConnectionCheckSchema.parse(input);
    const state = await this.ports.readState(args.mode);
    return result(
      this.change(args.mode, state.access_context, args.run_id, (run) => {
        if (
          run.status === args.status &&
          run.message === args.reason &&
          (!run.worker || run.worker.id === args.worker_id)
        )
          return run;
        this.version(run, args.expected_version);
        if (run.status === "running") this.owns(run, args.worker_id ?? "");
        else if (this.closed || run.status !== "queued")
          throw new ValidationError({ message: "This check has already stopped." });
        this.committing.get(run.id)?.abort();
        return this.updated(run, {
          status: args.status,
          message: args.reason,
          lease_expires_at_ms: 0,
        });
      }),
    );
  }

  async cancel(input: unknown): Promise<ConnectionCheckResult> {
    const args = cancelConnectionCheckSchema.parse(input);
    const state = await this.ports.readState(args.mode);
    const run = this.change(args.mode, state.access_context, args.run_id, (current) =>
      connectionCheckActive(current)
        ? this.updated(current, {
            status: "cancelled",
            message: "Check cancelled.",
            lease_expires_at_ms: 0,
          })
        : current,
    );
    this.committing.get(args.run_id)?.abort();
    return result(run);
  }

  async complete(input: unknown): Promise<ConnectionCheckResult> {
    const args = completeConnectionCheckSchema.parse(input);
    const state = await this.ports.readState(args.mode);
    const hash = createHash("sha256").update(JSON.stringify(args.observations)).digest("hex");
    const token = randomUUID();
    const run = this.change(args.mode, state.access_context, args.run_id, (current) => {
      if (
        current.status === "complete" &&
        current.worker?.id === args.worker_id &&
        current.observations_hash === hash
      )
        return current;
      this.owns(current, args.worker_id);
      this.version(current, args.expected_version);
      this.scope(current, state);
      this.validateObservations(current, args.observations);
      if (current.completion_token)
        throw new ValidationError({
          message: "Check results are already being saved. Read progress.",
        });
      return this.updated(current, { completion_token: token });
    });
    if (run.status === "complete") return result(run);
    const controller = new AbortController();
    this.committing.set(run.id, controller);
    const guard = (config: GoodfindsState["config"]) => {
      controller.signal.throwIfAborted();
      this.scope(run, { ...state, config });
      this.storage.transaction(args.mode, (db) => {
        const current = this.require(this.find(db, run.context_id, run.id));
        this.owns(current, args.worker_id);
        if (current.completion_token !== token)
          throw new ValidationError({ message: "This check's completion changed." });
      });
    };
    try {
      guard(state.config);
      const committed = await this.ports.record(
        args.observations,
        state,
        args.mode,
        controller.signal,
        guard,
      );
      const stamp = new Date(this.now()).toISOString();
      return result(
        this.change(args.mode, run.context_id, run.id, (current) => {
          if (current.status !== "running" || current.completion_token !== token) return current;
          return this.updated(current, {
            status: "complete",
            message:
              args.observations.length === run.targets.length
                ? "Check complete."
                : "Some marketplaces couldn’t be checked. Their status remains unknown.",
            lease_expires_at_ms: 0,
            observations_hash: hash,
            results: run.targets.map((target) => {
              const observation = args.observations.find(
                (item) => item.marketplace === target.marketplace,
              );
              return {
                marketplace: target.marketplace,
                browser: target.browser,
                status:
                  observation?.session?.status === "signed_in"
                    ? "signed_in"
                    : observation?.session?.status === "signed_out"
                      ? "signed_out"
                      : "unknown",
                checked_at: observation?.session
                  ? (committed.config.platform_sessions.findLast(
                      (session) =>
                        session.marketplace === observation.marketplace &&
                        session.browser === observation.access.browser &&
                        session.browser_id === observation.access.browser_id &&
                        session.host === observation.access.host &&
                        session.profile === observation.access.profile &&
                        session.context_id === run.context_id,
                    )?.checked_at ?? stamp)
                  : null,
              };
            }),
          });
        }),
      );
    } catch (error) {
      this.change(args.mode, run.context_id, run.id, (current) =>
        current.status === "running" && current.completion_token === token
          ? this.updated(current, {
              status: "failed",
              message: "Couldn’t save the check. Try again.",
              lease_expires_at_ms: 0,
            })
          : current,
      );
      throw error;
    } finally {
      this.committing.delete(run.id);
    }
  }

  private validateObservations(run: CheckRecord, observations: ConnectionCheckObservation[]): void {
    const seen = new Set<string>();
    const identities = new Map<string, string>();
    for (const observation of observations) {
      const target = run.targets.find((item) => item.marketplace === observation.marketplace);
      if (!target || seen.has(observation.marketplace))
        throw new ValidationError({ message: "Wrong marketplace in check results." });
      seen.add(observation.marketplace);
      if (
        observation.access.browser !== target.browser ||
        !observation.access.browser_id ||
        (target.browser_id !== null && observation.access.browser_id !== target.browser_id)
      )
        throw new ValidationError({ message: "Check results must match the selected browser." });
      const identity = JSON.stringify([
        observation.access.browser_id,
        observation.access.host,
        observation.access.profile,
      ]);
      const prior = identities.get(target.browser);
      if (prior && prior !== identity)
        throw new ValidationError({ message: "Check results have inconsistent browser profiles." });
      identities.set(target.browser, identity);
      const session = observation.session;
      if (
        session &&
        (observation.access.status !== "available" ||
          session.marketplace !== target.marketplace ||
          session.browser !== target.browser ||
          session.browser_id !== observation.access.browser_id ||
          session.host !== observation.access.host ||
          session.profile !== observation.access.profile)
      )
        throw new ValidationError({ message: "Check results have inconsistent sign-in evidence." });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const mode of ["live", "sample"] as const) {
      if (!this.storage.exists(mode)) continue;
      this.storage.transaction(mode, (db) => {
        this.recover(db);
        for (const run of db.active()) {
          if (run.owner_process_id === this.owner_process_id)
            db.save(
              this.updated(run, {
                status: "interrupted",
                message: "Check stopped. Try again.",
                lease_expires_at_ms: 0,
              }),
            );
        }
      });
    }
    for (const controller of this.committing.values()) controller.abort();
  }
}
