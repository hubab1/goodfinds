import { spawn } from "node:child_process";

/** Kill the whole Lake/Lean process group when a check is cancelled or times out. */
export async function runFormalProcess(
  command: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<string> {
  options.signal?.throwIfAborted();
  const executable = command[0];
  if (!executable) throw new Error("A formal check command is required");
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(executable, command.slice(1), {
      cwd: options.cwd,
      env: options.env,
      detached: grouped,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stopped: Error | undefined;
    const kill = () => {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // The process may already have exited between cancellation and cleanup.
      }
    };
    const abort = () => {
      stopped = new Error("Formal check cancelled", { cause: options.signal?.reason });
      kill();
    };
    const timeout = setTimeout(() => {
      stopped = new Error(`Formal check timed out: ${command.join(" ")}`);
      kill();
    }, options.timeoutMs ?? 240_000);
    process.once("exit", kill);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {
      /* An early compiler exit can close stdin. */
    });
    child.stdin.end(options.input);
    child.once("error", (error) => {
      stopped ??= error;
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      process.removeListener("exit", kill);
      if (stopped) reject(stopped);
      else if (code !== 0)
        reject(new Error(`Formal check failed (${command.join(" ")}):\n${stdout}${stderr}`));
      else resolve(stdout);
    });
  });
}
