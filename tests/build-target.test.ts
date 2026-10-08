import test from "node:test";
import assert from "node:assert/strict";
import {
  executableName,
  selectBuildTarget,
  supportedBuildTargets,
} from "../scripts/build-target.ts";

void test("native builds select the host OS and CPU without shipping a JavaScript runtime", () => {
  const hosts = [
    ["darwin", "arm64", "aarch64-apple-darwin"],
    ["darwin", "x64", "x86_64-apple-darwin"],
    ["win32", "x64", "x86_64-pc-windows-msvc"],
    ["win32", "arm64", "aarch64-pc-windows-msvc"],
    ["linux", "x64", "x86_64-unknown-linux-gnu"],
    ["linux", "arm64", "aarch64-unknown-linux-gnu"],
  ] as const;
  for (const [platform, architecture, expected] of hosts)
    assert.equal(selectBuildTarget(undefined, platform, architecture), expected);
  for (const target of supportedBuildTargets) {
    assert.equal(selectBuildTarget(target, "darwin", "arm64"), target);
    assert.equal(
      executableName(target),
      target.includes("windows") ? "goodfinds.exe" : "goodfinds",
    );
  }
  assert.throws(() => selectBuildTarget(undefined, "freebsd", "arm"));
  assert.throws(() => selectBuildTarget("bun-darwin-arm64"));
  assert.throws(() => selectBuildTarget("universal"));
});
