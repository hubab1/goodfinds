import type { BuildTarget } from "./build-target.ts";

/** Preserve Cargo's environment precedence and its whitespace-based RUSTFLAGS parsing. */
export function nativeBuildEnvironment(
  environment: NodeJS.ProcessEnv,
  target: BuildTarget,
  workspace: string,
  home: string,
): NodeJS.ProcessEnv {
  const encoded = environment["CARGO_ENCODED_RUSTFLAGS"];
  const flags =
    encoded === undefined
      ? (environment["RUSTFLAGS"] ?? "").split(/\s+/u).filter(Boolean)
      : encoded === ""
        ? []
        : encoded.split("\x1f");
  // rustc applies the last matching remap, so put the specific workspace after home.
  for (const [path, replacement] of [
    [home, "~"],
    [workspace, "goodfinds"],
  ] as const) {
    for (const prefix of new Set([path, path.replaceAll("\\", "/")]))
      flags.push(`--remap-path-prefix=${prefix}=${replacement}`);
  }
  if (target.includes("windows")) flags.push("-C", "target-feature=+crt-static");
  return { ...environment, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f") };
}
