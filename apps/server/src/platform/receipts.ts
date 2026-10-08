import { searchRunAction, sellerAction } from "@goodfinds/contracts/tool-names";
import type { Database } from "bun:sqlite";
import { Clock, Effect } from "effect";
import { get, execute } from "./sqlite.ts";
import { hash, iso, parseJson } from "../workspace/model.ts";
import { validation, ValidationError } from "../workspace/errors.ts";
import { stateSchema } from "@goodfinds/contracts/state";
import type { GoodfindsState } from "@goodfinds/contracts/state";
import type { z } from "zod";
import type { scheduledSearchCheck } from "../searches/scheduled-search.ts";
import type { executionSchema } from "@goodfinds/contracts/operations";
import { isCommandName } from "@goodfinds/contracts/operations";
import { commandResult } from "../workspace/command-results.ts";

export type WorkspaceCommandResult = {
  state: GoodfindsState;
  execution?: z.infer<typeof executionSchema>;
  scheduled_check?: ReturnType<typeof scheduledSearchCheck>;
  [key: string]: unknown;
};

// Call inside the transaction that owns the mutation. A receipt cannot survive a rollback.
export const withReceipt = Effect.fnUntraced(function* <E, F, R, R2>(
  db: Database,
  action: string,
  args: Record<string, unknown>,
  program: Effect.Effect<{ state: unknown; [key: string]: unknown }, E, R>,
  snapshot: () => Effect.Effect<unknown, F, R2>,
) {
  const requestId = args["request_id"];
  if (
    typeof requestId !== "string" ||
    sellerAction(action) !== undefined ||
    searchRunAction(action) !== undefined ||
    action === "get_workspace"
  ) {
    const raw = yield* program;
    const parsed: WorkspaceCommandResult = {
      ...raw,
      state: yield* validation(() => stateSchema.parse(raw.state)),
    };
    return parsed;
  }
  const inputHash = hash(args);
  const existing = yield* get<{
    operation: string;
    input_hash: string;
    result: string;
    created_at: string;
  }>(
    db,
    "SELECT operation,input_hash,result_json AS result,created_at FROM operation_receipts WHERE request_id=?",
    requestId,
  );
  if (existing) {
    if (existing.operation !== action || existing.input_hash !== inputHash)
      return yield* Effect.fail(
        new ValidationError({
          message: "This request_id was already used for different arguments",
        }),
      );
    const saved = yield* validation(() => parseJson<Record<string, unknown>>(existing.result));
    const state = yield* snapshot();
    const replay: WorkspaceCommandResult = {
      state: yield* validation(() => stateSchema.parse(state)),
      ...saved,
      receipt: {
        request_id: requestId,
        operation: action,
        replayed: true,
        committed_at: existing.created_at,
      },
    };
    return replay;
  }
  const raw = yield* program;
  const result: WorkspaceCommandResult = {
    ...raw,
    state: yield* validation(() => stateSchema.parse(raw.state)),
  };
  const committedAt = iso(yield* Clock.currentTimeMillis);
  const data = yield* validation(() =>
    (() => {
      if (!isCommandName(action)) throw new Error("Unsupported mutation");
      return commandResult(action, args, result);
    })(),
  );
  // Keep the original operation result, alongside a fresh panel snapshot on retry.
  const extras = Object.fromEntries(Object.entries(result).filter(([key]) => key !== "state"));
  yield* execute(db, "INSERT INTO operation_receipts VALUES (?,?,?,?,?)", [
    requestId,
    action,
    inputHash,
    JSON.stringify({ ...extras, operation_result: data }),
    committedAt,
  ]);
  return {
    ...result,
    operation_result: data,
    receipt: {
      request_id: requestId,
      operation: action,
      replayed: false,
      committed_at: committedAt,
    },
  };
});
