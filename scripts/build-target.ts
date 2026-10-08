import { z } from "zod";

export const supportedBuildTargets = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-musl",
  "aarch64-unknown-linux-musl",
] as const;
export type BuildTarget = (typeof supportedBuildTargets)[number];
const targetSchema = z.enum(supportedBuildTargets);

export function selectBuildTarget(
  requested: string | undefined,
  platform: string = process.platform,
  architecture: string = process.arch,
): BuildTarget {
  const hostTargets: Record<string, string> = {
    "darwin:arm64": "aarch64-apple-darwin",
    "darwin:x64": "x86_64-apple-darwin",
    "win32:x64": "x86_64-pc-windows-msvc",
    "win32:arm64": "aarch64-pc-windows-msvc",
    "linux:x64": "x86_64-unknown-linux-gnu",
    "linux:arm64": "aarch64-unknown-linux-gnu",
  };
  const selected = requested ?? hostTargets[`${platform}:${architecture}`];
  if (!selected)
    throw new Error(`No native Goodfinds build target for ${platform}/${architecture}`);
  return targetSchema.parse(selected);
}

export function executableName(target: BuildTarget): string {
  return target.includes("windows") ? "goodfinds.exe" : "goodfinds";
}

// Rust targets select an OS, CPU and system ABI. Cross-compiling also needs a target linker/SDK.
export const buildTarget = selectBuildTarget(process.env["GOODFINDS_BUILD_TARGET"]);
