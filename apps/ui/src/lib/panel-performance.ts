// Standard User Timing entries can be read by host/browser diagnostics without
// exposing buying criteria, listing identities or image contents.
const starts = new Map<string, number>();
export function startPanelMeasure(name: "startup" | "workspace-read") {
  starts.set(name, name === "startup" ? 0 : performance.now());
}
export function finishPanelMeasure(name: "startup" | "workspace-read") {
  const start = starts.get(name);
  if (start === undefined) return;
  starts.delete(name);
  const end = performance.now();
  performance.measure(`goodfinds:${name}`, { start, end });
  document.documentElement.setAttribute(`data-goodfinds-${name}-ms`, (end - start).toFixed(1));
}
