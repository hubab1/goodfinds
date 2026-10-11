/* eslint-disable no-await-in-loop -- Sequential polling observes process startup and exit. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { runFormalProcess } from "../scripts/formal-process.ts";

for (const stop of ["timeout", "abort"] as const) {
  void test(
    `formal ${stop} stops the compiler and its child process`,
    {
      skip: process.platform === "win32",
      timeout: 10_000,
    },
    async (t) => {
      const folder = await mkdtemp(resolve(tmpdir(), "goodfinds-formal-process-"));
      t.after(() => rm(folder, { recursive: true, force: true }));
      const controller = new AbortController();
      const file = resolve(folder, "child.json");
      const source = `
      const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {stdout:"inherit", stderr:"inherit"});
      await Bun.write(${JSON.stringify(file)}, JSON.stringify([process.pid, child.pid]));
      await child.exited;
    `;
      const work = runFormalProcess([process.execPath, "-e", source], {
        cwd: folder,
        signal: controller.signal,
        timeoutMs: stop === "timeout" ? 1000 : 5000,
      });
      const rejected = assert.rejects(work, stop === "timeout" ? /timed out/u : /cancelled/u);
      let pids: number[] = [];
      for (let attempt = 0; attempt < 100 && pids.length === 0; attempt++) {
        try {
          pids = z
            .array(z.number().int().positive())
            .parse(JSON.parse(await readFile(file, "utf8")));
        } catch {
          await Bun.sleep(10);
        }
      }
      assert.equal(pids.length, 2, "The probe must launch both processes before cancellation");
      if (stop === "abort") controller.abort();
      await rejected;
      for (const pid of pids) {
        let alive = true;
        for (let attempt = 0; attempt < 100 && alive; attempt++) {
          try {
            process.kill(pid, 0);
            await Bun.sleep(10);
          } catch {
            alive = false;
          }
        }
        assert.equal(alive, false, `Formal process ${pid} survived ${stop}`);
      }
    },
  );
}
