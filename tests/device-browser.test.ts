import test from "node:test";
import assert from "node:assert/strict";
import {
  createDeviceBrowserReader,
  parseDeviceBrowser,
} from "../apps/server/src/platform/device-browser.ts";

void test("device browser metadata accepts the actual handler without assuming Chrome", () => {
  assert.deepEqual(parseDeviceBrowser('{"id":"com.apple.Safari","name":"Safari"}'), {
    id: "com.apple.Safari",
    name: "Safari",
  });
  assert.deepEqual(parseDeviceBrowser('{"id":"company.thebrowser.Browser","name":" Arc "}'), {
    id: "company.thebrowser.Browser",
    name: "Arc",
  });
  for (const invalid of [
    "not JSON",
    "null",
    "{}",
    '{"id":"com.apple.Safari","name":""}',
    '{"id":"/Applications/Safari.app","name":"Safari"}',
    '{"id":"com.apple.Safari","name":"Safari\\nunsafe"}',
    '{"id":"com.apple.Safari","name":42}',
    JSON.stringify({ id: "x".repeat(201), name: "Safari" }),
    JSON.stringify({ id: "com.apple.Safari", name: "x".repeat(121) }),
    " ".repeat(4_097),
  ])
    assert.equal(parseDeviceBrowser(invalid), null);
});

void test("macOS reads the selected runtime and only queries NSWorkspace URL metadata", async () => {
  const commands: { command: string; args: readonly string[] }[] = [];
  const read = createDeviceBrowserReader({
    platform: "darwin",
    hasExecutable: (path) =>
      path === "/usr/bin/xcode-select" ||
      path === "/Library/Developer/CommandLineTools/usr/bin/swift",
    run: (command, args) => {
      commands.push({ command, args });
      return Promise.resolve(
        command === "/usr/bin/xcode-select"
          ? "/Library/Developer/CommandLineTools\n"
          : '{"id":"com.apple.Safari","name":"Safari"}',
      );
    },
  });
  assert.deepEqual(await read(), { id: "com.apple.Safari", name: "Safari" });
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0], { command: "/usr/bin/xcode-select", args: ["-p"] });
  assert.equal(commands[1]?.command, "/Library/Developer/CommandLineTools/usr/bin/swift");
  assert.equal(commands[1]?.args[0], "-e");
  assert.match(commands[1]?.args[1] ?? "", /urlForApplication\(toOpen: address\)/);
  assert.doesNotMatch(commands[1]?.args[1] ?? "", /\.open\(|AppleEvents|\bApplication\(/);
});

void test("concurrent reads share one query and recheck the default after the cache expires", async () => {
  let now = 100;
  let browser = { id: "com.apple.Safari", name: "Safari" };
  let queryCount = 0;
  const read = createDeviceBrowserReader({
    platform: "darwin",
    now: () => now,
    hasExecutable: () => true,
    run: async (command) => {
      await Promise.resolve();
      if (command === "/usr/bin/xcode-select") return "/Applications/Xcode.app/Contents/Developer";
      queryCount += 1;
      return JSON.stringify(browser);
    },
  });
  assert.deepEqual(await Promise.all([read(), read(), read()]), [browser, browser, browser]);
  assert.equal(queryCount, 1);
  browser = { id: "org.mozilla.firefox", name: "Firefox" };
  now += 30_000;
  assert.deepEqual(await read(), { id: "com.apple.Safari", name: "Safari" });
  assert.equal(queryCount, 1);
  now += 10 * 60_000;
  assert.deepEqual(await read(), browser);
  assert.equal(queryCount, 2);
});

void test("missing developer tools return unavailable without invoking the Swift system shim", async () => {
  const commands: string[] = [];
  const read = createDeviceBrowserReader({
    platform: "darwin",
    hasExecutable: (path) => path === "/usr/bin/xcode-select",
    run: (command) => {
      commands.push(command);
      return Promise.resolve("/Library/Developer/CommandLineTools");
    },
  });
  assert.equal(await read(), null);
  assert.deepEqual(commands, ["/usr/bin/xcode-select"]);
});

void test("unsupported platforms, malformed metadata and failed reads remain unavailable", async () => {
  let commands = 0;
  const unsupported = createDeviceBrowserReader({
    platform: "linux",
    run: () => {
      commands += 1;
      return Promise.resolve('{"id":"com.google.Chrome","name":"Chrome"}');
    },
  });
  assert.equal(await unsupported(), null);
  assert.equal(commands, 0);
  const unavailable = await Promise.all(
    [null, "relative/path", "/developer\ninvalid", " ".repeat(2_050)].map((result) => {
      const read = createDeviceBrowserReader({
        platform: "darwin",
        hasExecutable: () => true,
        run: () => Promise.resolve(result),
      });
      return read();
    }),
  );
  assert.deepEqual(unavailable, [null, null, null, null]);
  let attempts = 0;
  const failed = createDeviceBrowserReader({
    platform: "darwin",
    hasExecutable: () => true,
    run: () => {
      attempts += 1;
      return Promise.reject(new Error("Unavailable runtime"));
    },
  });
  assert.equal(await failed(), null);
  assert.equal(await failed(), null);
  assert.equal(attempts, 1);
});
