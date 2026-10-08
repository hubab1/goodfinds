import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import { dirname } from "node:path";
import { Cause, Effect, Exit } from "effect";
import type { Context } from "effect";
import { initializeWorkspaceDatabase } from "./database-schema.ts";
import { directory } from "./files.ts";
import type { StorageError } from "../workspace/errors.ts";
import { storage } from "../workspace/errors.ts";

export function all<T>(db: Database, sql: string, ...args: SQLQueryBindings[]) {
  return storage("query SQLite rows", () => db.query<T, SQLQueryBindings[]>(sql).all(...args));
}
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Callers specify the selected SQLite columns.
export function get<T>(db: Database, sql: string, ...args: SQLQueryBindings[]) {
  return storage("query SQLite row", () => db.query<T, SQLQueryBindings[]>(sql).get(...args));
}
export const execute = (db: Database, sql: string, args: SQLQueryBindings[] = []) =>
  storage("write SQLite", () => db.run(sql, args));
export const close = (db: Database) => storage("close SQLite", () => db.close()).pipe(Effect.orDie);

// This is the only synchronous runtime adapter inside storage. A Bun transaction cannot yield
// asynchronous work. Preserve the original failure cause while throwing to trigger SQLite rollback.
export function transaction<A, E, R>(
  db: Database,
  program: Effect.Effect<A, E, R>,
  mode: "immediate" | "deferred" = "immediate",
): Effect.Effect<A, E | StorageError, R> {
  return Effect.contextWith((context: Context.Context<R>) => {
    let outcome: Exit.Exit<A, E> | undefined;
    return storage("SQLite transaction", () => {
      const commit = db.transaction(() => {
        const exit = Effect.runSyncExitWith(context)(program);
        outcome = exit;
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause);
          // runSyncExit reports suspended fibers without stopping them. Stop them before
          // returning to Bun so a later continuation cannot write after the rollback.
          if (Cause.isAsyncFiberError(error)) error.fiber.interruptUnsafe(error.fiber.id);
          throw new Error("Rollback Effect transaction");
        }
        return exit.value;
      });
      return commit[mode]();
    }).pipe(
      Effect.catch((error): Effect.Effect<never, E | StorageError> =>
        outcome && Exit.isFailure(outcome) ? Effect.failCause(outcome.cause) : Effect.fail(error),
      ),
    );
  });
}

export const openDatabase = Effect.fn("openDatabase")(function* (path: string) {
  yield* directory(dirname(path));
  const db = yield* storage(
    "open SQLite",
    () => new Database(path, { create: true, strict: true }),
  );
  const initialize = Effect.gen(function* () {
    yield* execute(db, "PRAGMA busy_timeout = 10000");
    yield* storage("initialize workspace schema", () => initializeWorkspaceDatabase(db));
    return db;
  });
  return yield* initialize.pipe(
    Effect.catchCause((cause) => close(db).pipe(Effect.andThen(Effect.failCause(cause)))),
  );
});
