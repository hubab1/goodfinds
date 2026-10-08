import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { storage } from "../workspace/errors.ts";

export const exists = (path: string) => storage("check file", () => existsSync(path));
export const directory = (path: string, mode = 0o700) =>
  storage("create directory", () => mkdirSync(path, { recursive: true, mode }));
export const readText = (path: string) => storage("read file", () => readFileSync(path, "utf8"));
export const writeText = (path: string, text: string) =>
  storage("write file", () => writeFileSync(path, text));

export const atomicJson = Effect.fn("atomicJson")(function* (path: string, value: unknown) {
  const temporary = `${path}.${yield* Effect.sync(randomUUID)}.tmp`;
  const write = Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const fd = yield* Effect.acquireRelease(
          storage("open temporary configuration", () => openSync(temporary, "wx", 0o600)),
          (handle) => storage("close configuration", () => closeSync(handle)).pipe(Effect.orDie),
        );
        yield* storage("write configuration", () =>
          writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`),
        );
        yield* storage("sync configuration", () => fsyncSync(fd));
      }),
    );
    yield* storage("replace configuration", () => renameSync(temporary, path));
  });
  yield* write.pipe(
    Effect.ensuring(
      storage("remove temporary configuration", () => {
        if (existsSync(temporary)) unlinkSync(temporary);
      }).pipe(Effect.orDie),
    ),
  );
});
