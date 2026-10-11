import assert from "node:assert/strict";
import { mock } from "bun:test";
import { Window } from "happy-dom";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createNativeServer } from "./native-mcp.ts";
import { nativeOptions } from "./native-mcp.ts";
import { seedWorkspace } from "./workspace.ts";
import { stateFromToolResult } from "@goodfinds/contracts/state";
import { monitoringSummary } from "@goodfinds/contracts/monitoring";
import type { MonitoringSummary, MonitoringRecord } from "@goodfinds/contracts/monitoring";

const dom = new Window({ url: "https://panel.example", width: 1000, height: 900 });
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "Element",
  "Node",
  "MutationObserver",
  "ResizeObserver",
  "Event",
  "KeyboardEvent",
  "FocusEvent",
  "PointerEvent",
  "MouseEvent",
  "SVGElement",
  "IntersectionObserver",
])
  Object.defineProperty(globalThis, key, {
    value: key === "window" ? dom : Reflect.get(dom, key),
    configurable: true,
  });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const)
  Object.defineProperty(globalThis, key, { value: dom[key].bind(dom), configurable: true });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-monitoring-ui-"));
const { server, calls } = createNativeServer(
  seedWorkspace(folder),
  nativeOptions(folder, null, () => Promise.resolve(null)),
);
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const handler = calls.get(name);
  assert.ok(handler, name);
  const result = await handler(args);
  assert.ok(!result.isError, JSON.stringify(result));
  return result;
};
const requests: string[] = [];
let finishRequest: (() => void) | undefined;
await mock.module("../../apps/ui/src/lib/client.ts", () => ({
  requestHostAction: (request: string) => {
    requests.push(request);
    return new Promise<void>((done) => {
      finishRequest = done;
    });
  },
  getSavedImage: () => Promise.resolve(""),
}));
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SearchListRow } = await import("../../apps/ui/src/features/searches/search-list-row.tsx");
const state = stateFromToolResult(await call("get_goodfinds_workspace"));
const search = state.searches[0];
assert.ok(search);
const record: MonitoringRecord = {
  search_id: search.id,
  preference: "recurring",
  interval_minutes: 120,
  timing: null,
  allow_quiet_hours: false,
  interruption: null,
  last_scheduled_run_at: null,
};
const savedSchedule = {
  automation_id: "fixture-schedule",
  thread_id: "00000000-0000-4000-8000-000000000001",
  status: "paused",
  interval_minutes: 120,
  evidence: "Fixture",
  verified_at: "2026-10-11T12:00:00Z",
  next_run_at: null,
  last_run_at: null,
};
const quietHours = { enabled: false, start: "22:00", end: "08:00", timezone: "Europe/London" };
const summary = (status: "paused" | "removed" | "active"): MonitoringSummary =>
  monitoringSummary(
    search,
    [record],
    120,
    false,
    false,
    null,
    quietHours,
    Date.parse("2026-10-11T12:00:00Z"),
    {
      dispatcher: {
        id: "00000000-0000-4000-8000-000000000002",
        thread_id: savedSchedule.thread_id,
        host_id: "local",
        notification_policy: null,
        search_ids: [search.id],
        schedule: {
          ...savedSchedule,
          status,
          rrule: "FREQ=HOURLY;INTERVAL=2",
          timezone: "Europe/London",
        },
      },
      host_schedule: null,
      plan: {
        search_ids: [search.id],
        times: [],
        rrule: "FREQ=HOURLY;INTERVAL=2",
        timezone: "Europe/London",
        interval_minutes: 120,
        supported: true,
        explanation: "Fixture",
        next_wake_at: null,
        revision: state.revision,
      },
    },
  );
const container = document.createElement("ul");
document.body.append(container);
const root = createRoot(container);
const pause = () => new Promise((done) => setTimeout(done, 20));
const render = async (monitoring: MonitoringSummary) => {
  await act(async () => {
    root.render(
      createElement(SearchListRow, {
        search,
        monitoring,
        origin: "London",
        sample: false,
        revision: state.revision,
        busy: false,
        action: async () => undefined,
        edit: () => {},
        onSearch: () => {},
      }),
    );
    await pause();
  });
};
const visibleButton = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === label && !button.closest("[hidden]"),
  );
try {
  await render(summary("paused"));
  const resume = visibleButton("Resume");
  assert.ok(resume, "Paused monitoring must expose Resume on the collapsed search card");
  const details = container.querySelector<HTMLElement>(".search-row-details");
  assert.ok(details?.hidden, "Timing and recovery explanations stay behind Details");
  const metrics = container.querySelector(".search-row-metrics");
  assert.match(metrics?.textContent ?? "", /SchedulePausedLast searched/);
  const actions = [...container.querySelectorAll(".search-row-buttons button")];
  assert.equal(actions[0], resume);
  assert.equal(actions[1]?.textContent, "Details", "Resume is immediately before Details");
  assert.match(details.textContent ?? "", /Every 2 hours/i);
  await act(async () => {
    resume.click();
    await pause();
  });
  assert.equal(requests.length, 1);
  assert.match(requests[0] ?? "", /preference recurring/);
  assert.match(requests[0] ?? "", /enabled true/);
  assert.ok(
    visibleButton("Resuming…")?.disabled,
    "The pending request is visible and cannot be duplicated",
  );
  await act(async () => {
    finishRequest?.();
    await pause();
  });
  assert.match(container.textContent ?? "", /Awaiting confirmation/);
  assert.ok(visibleButton("Resume"), "Dispatch alone does not claim the schedule is active");
  await render(summary("active"));
  assert.ok(visibleButton("Pause"));
  assert.doesNotMatch(container.textContent ?? "", /Awaiting confirmation/);
  await render(summary("removed"));
  assert.ok(visibleButton("Resume"), "Removed schedules need a direct recovery action");
  await act(async () => {
    const restore = visibleButton("Resume");
    assert.ok(restore);
    restore.click();
    await pause();
  });
  assert.match(requests[1] ?? "", /original buying chat is unavailable/);
  assert.match(requests[1] ?? "", /current chat/);
  await act(async () => {
    finishRequest?.();
    await pause();
  });
} finally {
  await act(async () => root.unmount());
  await server.close();
  rmSync(folder, { recursive: true, force: true });
  await dom.happyDOM.close();
}
