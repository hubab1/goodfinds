import { resolve } from "node:path";

const child = Bun.spawn(
  [process.execPath, "test", "--timeout", "300000", "tests/formal-seller-action.test.ts"],
  {
    cwd: resolve(import.meta.dir, ".."),
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exitCode = await child.exited;
