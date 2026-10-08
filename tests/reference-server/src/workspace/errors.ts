import { WorkflowViolation } from "@goodfinds/contracts/workflow-model";
import type { Blocker } from "@goodfinds/contracts/workflow-model";
import { Data, Effect } from "effect";
import type { z } from "zod";
import type { errorSchema } from "@goodfinds/contracts/operations";
import { errorMessage } from "@goodfinds/contracts/state";

export class ValidationError extends Data.TaggedError("ValidationError")<{
  message: string;
  cause?: unknown;
  blockers?: Blocker[];
}> {}
export class RevisionConflict extends Data.TaggedError("RevisionConflict")<{
  message: string;
  current_revision?: string;
  resource?: string;
}> {}
export class MissingSearch extends Data.TaggedError("MissingSearch")<{ message: string }> {}
export class StorageError extends Data.TaggedError("StorageError")<{
  message: string;
  operation: string;
  cause: unknown;
}> {}
export class MediaError extends Data.TaggedError("MediaError")<{
  message: string;
  cause?: unknown;
}> {}
export class TransportError extends Data.TaggedError("TransportError")<{
  message: string;
  cause?: unknown;
}> {}
export type GoodfindsError =
  | ValidationError
  | RevisionConflict
  | MissingSearch
  | StorageError
  | MediaError
  | TransportError;

export function validation<A>(
  evaluate: () => A,
): Effect.Effect<A, ValidationError | RevisionConflict | MissingSearch> {
  return Effect.try({
    try: evaluate,
    catch: (cause) =>
      cause instanceof ValidationError ||
      cause instanceof RevisionConflict ||
      cause instanceof MissingSearch
        ? cause
        : new ValidationError({
            message: errorMessage(cause),
            cause,
            ...(cause instanceof WorkflowViolation ? { blockers: cause.blockers } : {}),
          }),
  });
}
export function storage<A>(operation: string, evaluate: () => A): Effect.Effect<A, StorageError> {
  return Effect.try({
    try: evaluate,
    catch: (cause) => new StorageError({ message: errorMessage(cause), operation, cause }),
  });
}
export function mediaOperation<A>(
  evaluate: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, MediaError> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new MediaError({ message: errorMessage(cause), cause }),
  });
}
export function transport<A>(
  evaluate: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, TransportError> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new TransportError({ message: errorMessage(cause), cause }),
  });
}

export function errorDetails(error: unknown): z.infer<typeof errorSchema> {
  const code =
    error instanceof RevisionConflict
      ? "revision_conflict"
      : error instanceof MissingSearch
        ? "missing_search"
        : error instanceof ValidationError
          ? "validation_error"
          : error instanceof StorageError
            ? "storage_error"
            : error instanceof MediaError
              ? "media_error"
              : error instanceof TransportError
                ? "transport_error"
                : error instanceof Error && error.name === "AbortError"
                  ? "cancelled"
                  : "internal_error";
  return {
    code,
    message: errorMessage(error),
    retryable: code === "revision_conflict" || code === "transport_error",
    ...(error instanceof RevisionConflict && error.current_revision
      ? { current_revision: error.current_revision }
      : {}),
    ...(error instanceof RevisionConflict && error.resource ? { resource: error.resource } : {}),
    ...(error instanceof ValidationError && error.blockers ? { blockers: error.blockers } : {}),
    recovery:
      code === "revision_conflict"
        ? "Read the resource, reconcile the edit and retry with its new revision."
        : code === "transport_error"
          ? "Retry with the same request_id; reconcile uncertain external actions before repeating them."
          : code === "validation_error"
            ? "Correct the supplied arguments."
            : code === "missing_search"
              ? "Refresh the saved searches."
              : "Read current state before retrying; retain the original request_id.",
  };
}
