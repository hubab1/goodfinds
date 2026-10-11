import { spawn } from "node:child_process";
import { Effect } from "effect";
import { nativeBinary } from "./native-driver.ts";
export async function startPreview(workspaceDirectory: string, port = 0) {
  const child = spawn(nativeBinary, ["--preview"], {
    env: {
      ...process.env,
      GOODFINDS_WORKSPACE_DIR: workspaceDirectory,
      GOODFINDS_TEST_AUTOMATIONS: "",
      GOODFINDS_TEST_BROWSER: "null",
      GOODFINDS_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const url = await new Promise<string>((done, reject) => {
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//u);
      if (match) done(match[0]);
    });
    child.once("error", reject);
    child.once("exit", () =>
      reject(new Error(errors || "Native preview stopped before listening")),
    );
  });
  const close = () =>
    new Promise<void>((done) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        done();
        return;
      }
      child.once("exit", () => done());
      child.kill("SIGTERM");
    });
  return {
    url,
    shutdown: Effect.promise(close),
    http: {
      close(callback: (error?: Error) => void) {
        void close()
          .then(() => callback())
          .catch(callback);
      },
    },
  };
}
