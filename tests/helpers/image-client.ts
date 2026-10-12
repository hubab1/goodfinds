import assert from "node:assert/strict";
import { mock } from "bun:test";

Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
let requests = 0;
await mock.module("@modelcontextprotocol/ext-apps", () => ({
  App: class {
    addEventListener() {}
    connect() {
      return Promise.resolve();
    }
    getHostContext() {
      return {};
    }
    callServerTool() {
      requests += 1;
      return Promise.resolve({
        content: [{ type: "image", mimeType: "image/avif", data: "AAAAFGZ0eXBhdmlmAAAAAGF2aWY=" }],
      });
    }
  },
  applyDocumentTheme() {},
}));
const { getSavedImage } = await import("../../apps/ui/src/lib/client");
const source = await getSavedImage("a".repeat(64));
assert.ok(source.startsWith("data:image/avif;base64,"));
assert.equal(requests, 1, "A supported AVIF response must not cause repeated host requests");
