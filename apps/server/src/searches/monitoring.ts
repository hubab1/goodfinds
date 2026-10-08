import {
  hostScheduleReportSchema,
  monitoringPreferenceSchema,
} from "@goodfinds/contracts/monitoring";
import type { WorkspaceConfiguration } from "../workspace/model.ts";
import { iso } from "../workspace/model.ts";
import { schedulePlan, canonicalRule } from "@goodfinds/contracts/search-timing";
import { dispatcherForSearch } from "@goodfinds/contracts/scheduled-dispatch";

export function setMonitoring(config: WorkspaceConfiguration, input: unknown) {
  const request = monitoringPreferenceSchema.parse(input);
  const search = config.searches.find((item) => item.id === request.search_id);
  if (!search) throw new Error("Choose a saved search");
  const previous = config.monitoring.find((item) => item.search_id === search.id);
  const timing =
    request.timing ??
    (request.interval_minutes !== undefined
      ? { mode: "interval" as const, interval_minutes: request.interval_minutes }
      : (previous?.timing ?? null));
  const record = {
    search_id: search.id,
    preference: request.preference,
    interval_minutes:
      timing?.mode === "daily"
        ? 1440
        : (timing?.interval_minutes ??
          previous?.interval_minutes ??
          config.schedule.interval_minutes),
    timing,
    allow_quiet_hours: request.allow_quiet_hours ?? previous?.allow_quiet_hours ?? false,
    schedule: previous?.schedule ?? null,
    interruption: previous?.interruption ?? null,
    last_scheduled_run_at: previous?.last_scheduled_run_at ?? null,
  };
  config.monitoring = config.monitoring.filter((item) => item.search_id !== search.id);
  config.monitoring.push(record);
  if (request.preference === "recurring") search.enabled = true;
}

export function recordSchedule(config: WorkspaceConfiguration, input: unknown, now: number) {
  const report = hostScheduleReportSchema.parse(input);
  if (dispatcherForSearch(config, report.search_id))
    throw new Error(
      "This search uses a shared schedule. Reconcile it with report_goodfinds_dispatcher_schedule.",
    );
  const search = config.searches.find((item) => item.id === report.search_id);
  const record = config.monitoring.find((item) => item.search_id === report.search_id);
  if (!search || !record)
    throw new Error("Save the buyer's monitoring choice for this search first");
  const previous = record.schedule;
  if (
    report.automation_id &&
    config.monitoring.some(
      (item) =>
        item.search_id !== search.id && item.schedule?.automation_id === report.automation_id,
    )
  )
    throw new Error("That automation belongs to another saved search");
  if (previous && previous.thread_id !== report.thread_id)
    throw new Error("Keep this schedule in its original buying thread");
  if (
    previous?.automation_id &&
    previous.status !== "removed" &&
    report.automation_id &&
    previous.automation_id !== report.automation_id
  )
    throw new Error("Update the existing automation instead of creating a duplicate");
  if (report.status === "active" && (!search.enabled || record.preference !== "recurring"))
    throw new Error("Recurring checks require an enabled search and the buyer's search choice");
  if (report.status === "active" && report.interval_minutes !== record.interval_minutes)
    throw new Error("Verify the host schedule at the buyer's saved frequency");
  if (report.status === "active" && report.rrule) {
    const plan = schedulePlan(
      record.timing ?? { mode: "interval", interval_minutes: record.interval_minutes },
      config.schedule.quiet_hours,
      record.allow_quiet_hours,
    );
    if (
      !plan.rrule ||
      canonicalRule(report.rrule) !== canonicalRule(plan.rrule) ||
      report.timezone !== plan.timezone
    )
      throw new Error("Verify the host schedule's saved times, quiet hours and time zone");
  }
  if (report.status === "blocked") {
    record.interruption = report.evidence;
    // A failed check is not evidence that the previously active automation stopped.
    if (previous) return;
  } else record.interruption = null;
  const { search_id: _searchId, ...receipt } = report;
  record.schedule = {
    ...receipt,
    last_run_at:
      receipt.last_run_at ??
      (previous?.automation_id === receipt.automation_id ? (previous?.last_run_at ?? null) : null),
    verified_at: iso(now),
  };
}
