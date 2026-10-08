import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { buildTarget, executableName } from "./build-target.ts";
import { nativeBuildEnvironment } from "./build-environment.ts";

const root = resolve(import.meta.dir, "..");
const output = resolve(root, "dist/build/server");
mkdirSync(output, { recursive: true });
rmSync(resolve(output, "build.json"), { force: true });

async function run(command: string[], env = process.env): Promise<void> {
  const child = Bun.spawn(command, { cwd: root, env, stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0)
    throw new Error(
      `Native Goodfinds build failed: ${command.join(" ")}. Install the Rust target and its platform linker/SDK before cross-compiling.`,
    );
}

// Both inputs are embedded into the executable by Rust's build script.
await run([process.execPath, "scripts/generate-native-contracts.ts"], {
  ...process.env,
  TZ: "UTC",
});
await run([process.execPath, "run", "--filter", "@goodfinds/ui", "build"]);
const home = homedir();
const environment = nativeBuildEnvironment(process.env, buildTarget, root, home);
await run(
  [
    "cargo",
    "build",
    "--manifest-path",
    "apps/server/Cargo.toml",
    "--locked",
    "--release",
    "--target",
    buildTarget,
  ],
  environment,
);
const name = executableName(buildTarget);
const targetDirectory = resolve(root, process.env["CARGO_TARGET_DIR"] ?? "apps/server/target");
const compiled = resolve(targetDirectory, buildTarget, "release", name);
const binary = readFileSync(compiled);
for (const path of new Set([home, home.replaceAll("\\", "/"), root, root.replaceAll("\\", "/")]))
  if (path.length > 1 && binary.includes(Buffer.from(path)))
    throw new Error(
      "Native executable contains a local build path; check compiler path remapping.",
    );
const staging = resolve(output, `${name}.pending`);
copyFileSync(compiled, staging);
renameSync(staging, resolve(output, name));
rmSync(resolve(output, "goodfinds.mjs"), { force: true });
writeFileSync(
  resolve(output, "build.json"),
  `${JSON.stringify({ target: buildTarget, runtime: "native-rust", executable: name })}\n`,
);
