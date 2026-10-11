import { resolve } from "node:path";

const prepared = Bun.spawn([process.execPath, "run", "test:prepare"], {
  cwd: resolve(import.meta.dir, ".."),
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
const preparedCode = await prepared.exited;
if (preparedCode !== 0) process.exit(preparedCode);

const child = Bun.spawn(
  [process.execPath, "test", "--timeout", "300000", "./tests/formal-seller-action.test.ts"],
  {
    cwd: resolve(import.meta.dir, ".."),
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exitCode = await child.exited;
