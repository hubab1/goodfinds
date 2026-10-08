import { dispatcherReportSchema, dispatcherPlan } from "@goodfinds/contracts/scheduled-dispatch";
import type { HostScheduleObservation } from "@goodfinds/contracts/monitoring";
import { canonicalRule } from "@goodfinds/contracts/search-timing";
import type { WorkspaceConfiguration } from "../workspace/model.ts";
import { hash, iso } from "../workspace/model.ts";

export function recordDispatcher(
  config: WorkspaceConfiguration,
  input: unknown,
  now: number,
  fulfilled: Set<string>,
  hosts: Map<string, HostScheduleObservation>,
) {
  const report = dispatcherReportSchema.parse(input);
  if (report.plan_revision !== hash(config))
    throw new Error(
      "The shared schedule plan changed. Read its context again before reporting it.",
    );
  const previous = config.dispatchers.find((d) => d.id === report.dispatcher_id);
  if (
    previous &&
    (previous.thread_id !== report.thread_id ||
      previous.host_id !== report.host_id ||
      previous.notification_policy !== report.notification_policy)
  )
    throw new Error("Preserve the original host, buying chat and notification settings");
  if (
    report.schedule.status !== "blocked" &&
    previous?.schedule?.automation_id &&
    previous.schedule.status !== "removed" &&
    report.schedule.automation_id !== previous.schedule.automation_id
  )
    throw new Error("Reuse the existing shared automation");
  for (const id of report.search_ids) {
    const search = config.searches.find((s) => s.id === id),
      m = config.monitoring.find((item) => item.search_id === id);
    if (!search || !m || m.preference !== "recurring")
      throw new Error("Only searches with an existing recurring choice can join a dispatcher");
    if (config.dispatchers.some((d) => d.id !== report.dispatcher_id && d.search_ids.includes(id)))
      throw new Error("This search already belongs to another dispatcher");
    if (m.schedule?.thread_id && m.schedule.thread_id !== report.thread_id)
      throw new Error("Keep each search in its original buying chat");
    if (
      report.schedule.status !== "blocked" &&
      m.schedule?.automation_id &&
      m.schedule.automation_id !== report.schedule.automation_id
    ) {
      const status = hosts.get(id)?.status ?? m.schedule.status;
      if (!["paused", "removed"].includes(status))
        throw new Error("Pause and verify the redundant automation before migrating this search");
    }
  }
  if (report.schedule.status === "blocked") {
    for (const m of config.monitoring.filter((item) => report.search_ids.includes(item.search_id)))
      m.interruption = report.schedule.evidence;
    return;
  }
  if (
    previous &&
    report.schedule.status === "active" &&
    previous.search_ids.some(
      (id) =>
        !report.search_ids.includes(id) &&
        config.searches.some((s) => s.id === id && s.enabled) &&
        config.monitoring.some((m) => m.search_id === id && m.preference === "recurring") &&
        !fulfilled.has(id),
    )
  )
    throw new Error("Pause or stop a search before removing its active dispatcher membership");
  const plan = dispatcherPlan(config, report.search_ids, fulfilled, now, hash(config));
  if (
    !previous &&
    config.dispatchers.some(
      (d) =>
        d.thread_id === report.thread_id &&
        d.host_id === report.host_id &&
        d.notification_policy === report.notification_policy &&
        d.schedule?.status !== "removed" &&
        dispatcherPlan(
          config,
          [...new Set([...d.search_ids, ...report.search_ids])],
          fulfilled,
          now,
          hash(config),
        ).supported,
    )
  )
    throw new Error(
      "Join the existing compatible dispatcher instead of creating a duplicate schedule",
    );
  if (
    config.dispatchers.some(
      (d) =>
        d.id !== report.dispatcher_id &&
        d.schedule?.automation_id === report.schedule.automation_id,
    )
  )
    throw new Error("That host automation already belongs to another dispatcher");
  if (
    report.schedule.status === "active" &&
    (!plan.supported ||
      !plan.rrule ||
      canonicalRule(report.schedule.rrule ?? "") !== canonicalRule(plan.rrule) ||
      report.schedule.timezone !== plan.timezone)
  )
    throw new Error("Verify the shared recurrence against the current dispatcher plan");
  const schedule = { ...report.schedule, verified_at: iso(now) };
  const dispatcher = {
    id: report.dispatcher_id,
    thread_id: report.thread_id,
    host_id: report.host_id,
    notification_policy: report.notification_policy,
    search_ids: report.search_ids,
    schedule,
  };
  config.dispatchers = config.dispatchers.filter((d) => d.id !== dispatcher.id);
  config.dispatchers.push(dispatcher);
  for (const m of config.monitoring.filter((item) => report.search_ids.includes(item.search_id))) {
    m.last_scheduled_run_at ??= m.schedule?.last_run_at ?? null;
    m.schedule = null;
    m.interruption = null;
  }
}
