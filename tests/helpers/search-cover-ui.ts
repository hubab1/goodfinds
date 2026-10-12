import assert from "node:assert/strict";
import { mock } from "bun:test";
import { Window } from "happy-dom";
import { savedSearchSchema } from "@goodfinds/contracts/state";
import { SEARCH_TEMPLATES } from "@goodfinds/contracts/search-definition";

const dom = new Window({ url: "https://panel.example" });
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
])
  Object.defineProperty(globalThis, key, {
    value: key === "window" ? dom : Reflect.get(dom, key),
    configurable: true,
  });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
Object.defineProperty(globalThis, "IntersectionObserver", {
  value: class {
    private callback: (entries: { isIntersecting: boolean }[]) => void;
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
      this.callback = callback;
    }
    observe() {
      this.callback([{ isIntersecting: true }]);
    }
    disconnect() {}
  },
  configurable: true,
});
let attempts = 0;
await mock.module("../../apps/ui/src/lib/client", () => ({
  getSavedImage: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("Host image request failed");
    return "data:image/png;base64,iVBORw0KGgo=";
  },
}));
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SearchCover } = await import("../../apps/ui/src/features/searches/search-cover");
const search = savedSearchSchema.parse({
  id: "mac",
  name: "MacBook Pro",
  product: "macbook_pro",
  definition: SEARCH_TEMPLATES.find((t) => t.category === "macbook_pro"),
  values: {},
  cover: {
    media_id: "a".repeat(64),
    kind: "manufacturer",
    alt: "Representative MacBook Pro",
    source_name: "Apple",
    source_url: "https://www.apple.com/macbook-pro/",
  },
});
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
try {
  await act(async () => root.render(createElement(SearchCover, { search })));
  assert.match(container.textContent ?? "", /Cover unavailable/);
  const retry = container.querySelector("button");
  assert.ok(retry && retry.textContent?.includes("Retry cover"));
  await act(async () => retry.click());
  assert.equal(attempts, 2);
  assert.ok(container.querySelector("img")?.getAttribute("src")?.startsWith("data:image/png"));
  assert.doesNotMatch(container.textContent ?? "", /Cover unavailable/);
} finally {
  await act(async () => root.unmount());
  await dom.happyDOM.close();
}
