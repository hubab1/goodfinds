import { resolve } from "node:path";

export async function formatSource(path: string, source: string): Promise<string> {
  const child = Bun.spawn([process.execPath, "fmt", "--stdin-filepath", path], {
    cwd: resolve(import.meta.dir, ".."),
    stdin: new TextEncoder().encode(source),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) throw new Error(`Cannot format ${path}: ${error}`);
  return output;
}
