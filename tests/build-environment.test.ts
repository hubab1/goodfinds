import test from "node:test";
import assert from "node:assert/strict";
import { nativeBuildEnvironment } from "../scripts/build-environment.ts";

void test("native builds preserve explicit Cargo flags while removing local source paths", () => {
  const environment = { RUSTFLAGS: "-C debuginfo=1\n--cfg build_test", KEEP: "value" };
  const result = nativeBuildEnvironment(
    environment,
    "aarch64-apple-darwin",
    "/Users/Example Buyer/source tree",
    "/Users/Example Buyer",
  );
  assert.equal(result["KEEP"], "value");
  assert.deepEqual(result["CARGO_ENCODED_RUSTFLAGS"]?.split("\x1f"), [
    "-C",
    "debuginfo=1",
    "--cfg",
    "build_test",
    "--remap-path-prefix=/Users/Example Buyer=~",
    "--remap-path-prefix=/Users/Example Buyer/source tree=goodfinds",
  ]);
  assert.equal(environment.RUSTFLAGS, "-C debuginfo=1\n--cfg build_test");
});

void test("encoded Cargo flags take precedence and Windows bundles the C runtime", () => {
  const result = nativeBuildEnvironment(
    {
      CARGO_ENCODED_RUSTFLAGS: '--cfg\x1ffixture="space preserved"',
      RUSTFLAGS: "--cfg ignored",
    },
    "x86_64-pc-windows-msvc",
    "C:\\Users\\Example Buyer\\source",
    "C:\\Users\\Example Buyer",
  );
  assert.deepEqual(result["CARGO_ENCODED_RUSTFLAGS"]?.split("\x1f"), [
    "--cfg",
    'fixture="space preserved"',
    "--remap-path-prefix=C:\\Users\\Example Buyer=~",
    "--remap-path-prefix=C:/Users/Example Buyer=~",
    "--remap-path-prefix=C:\\Users\\Example Buyer\\source=goodfinds",
    "--remap-path-prefix=C:/Users/Example Buyer/source=goodfinds",
    "-C",
    "target-feature=+crt-static",
  ]);
  const empty = nativeBuildEnvironment(
    { CARGO_ENCODED_RUSTFLAGS: "", RUSTFLAGS: "--cfg ignored" },
    "x86_64-unknown-linux-gnu",
    "/build/source",
    "/home/builder",
  );
  assert.equal(empty["CARGO_ENCODED_RUSTFLAGS"]?.includes("ignored"), false);
});
