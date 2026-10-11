import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import { errorSchema } from "@goodfinds/contracts/operations";

const executableSuffix = process.platform === "win32" ? ".exe" : "";
export const nativeBinary = resolve(
  process.env["GOODFINDS_TEST_BINARY"] ??
    `apps/server/target/test-support/goodfinds${executableSuffix}`,
);
const driver = resolve(`apps/server/target/test-support/examples/test-driver${executableSuffix}`);
export const nativeContext = "00000000-0000-4000-8000-000000000099";
export class NativeError extends Error {
  readonly details: z.infer<typeof errorSchema>;
  constructor(details: z.infer<typeof errorSchema>) {
    super(details.message);
    this.details = details;
  }
}
export class RevisionConflict extends NativeError {}
export function errorDetails(error: unknown) {
  if (!(error instanceof NativeError)) throw error;
  return error.details;
}
let address: string | undefined;
function driverAddress() {
  if (address) return address;
  const directory = mkdtempSync(resolve(tmpdir(), "goodfinds-test-driver-"));
  const ready = resolve(directory, "address");
  const child = Bun.spawn([driver, "--serve", ready], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
  });
  child.unref();
  process.once("exit", () => {
    child.kill();
    rmSync(directory, { recursive: true, force: true });
  });
  const limit = Date.now() + 10000;
  while (!existsSync(ready)) {
    if (Date.now() > limit) throw new Error("Native test driver did not start");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  address = readFileSync(ready, "utf8");
  return address;
}
export function nativeCall(input: Record<string, unknown>): unknown {
  const result = spawnSync(driver, ["--client", driverAddress()], {
    input: JSON.stringify({
      now: Date.now(),
      browser: null,
      ...input,
      automationsDirectory: input["automationsDirectory"] ?? "",
    }),
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(result.stderr || `Native driver exited ${result.status}`);
  const envelope = z
    .object({ value: z.unknown().optional(), error: errorSchema.optional() })
    .parse(JSON.parse(result.stdout) as unknown);
  if (envelope.error)
    throw envelope.error.code === "revision_conflict"
      ? new RevisionConflict(envelope.error)
      : new NativeError(envelope.error);
  return envelope.value;
}
export const nativeEffect = (input: Record<string, unknown>) =>
  Effect.try({ try: () => nativeCall(input), catch: (e) => e });
