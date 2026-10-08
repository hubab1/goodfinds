import type { WorkspaceConfiguration } from "../workspace/model.ts";
import type { SearchRun } from "@goodfinds/contracts/search-workflow";
import { ACTIVE_SEARCH_PHASES } from "@goodfinds/contracts/search-workflow";
import { dispatcherForSearch } from "@goodfinds/contracts/scheduled-dispatch";
import type { HostScheduleObservation } from "@goodfinds/contracts/monitoring";
import {
  schedulePlan,
  inQuietHours,
  nextLocalTime,
  dailyTimeDue,
  localSlot,
} from "@goodfinds/contracts/search-timing";

export function scheduledSearchCheck(
  config: WorkspaceConfiguration,
  searchId: string,
  now: number,
  fulfilled: Set<string>,
  runs: SearchRun[] = [],
  dispatch = true,
  host: HostScheduleObservation | null = null,
) {
  const search = config.searches.find((item) => item.id === searchId);
  const record = config.monitoring.find((item) => item.search_id === searchId);
  const timing = record?.timing ?? {
    mode: "interval" as const,
    interval_minutes: record?.interval_minutes ?? config.schedule.interval_minutes,
  };
  const plan = schedulePlan(timing, config.schedule.quiet_hours, record?.allow_quiet_hours);
  const result = (
    allowed: boolean,
    reason: string,
    explanation: string,
    next: string | null = null,
  ) => ({
    search_id: searchId,
    allowed,
    reason,
    explanation,
    next_allowed_at: next,
    checked_at: new Date(now).toISOString(),
    plan,
  });
  if (!search) return result(false, "search_removed", "This saved search was removed.");
  if (fulfilled.has(searchId)) return result(false, "fulfilled", "This buying goal is fulfilled.");
  if (!search.enabled || record?.preference !== "recurring")
    return result(false, "monitoring_off", "Recurring checks are off for this search.");
  const dispatcher = dispatcherForSearch(config, searchId);
  if (dispatcher && (host?.status ?? dispatcher.schedule?.status) !== "active")
    return result(false, "dispatcher_paused", "The shared schedule is paused or unverified.");
  if (!plan.rrule)
    return result(
      false,
      "no_active_times",
      "All saved search times fall within quiet hours. Change the times or explicitly allow overnight checks.",
    );
  if (inQuietHours(now, plan.quiet_hours))
    return result(
      false,
      "quiet_hours",
      `Scheduled searches pause from ${plan.quiet_hours.start} to ${plan.quiet_hours.end} (${plan.timezone}).`,
      nextLocalTime(plan.times.length ? plan.times : [plan.quiet_hours.end], plan.timezone, now),
    );
  if (
    !dispatch ||
    runs.some((run) => run.search_id === searchId && ACTIVE_SEARCH_PHASES.has(run.phase))
  )
    return result(true, "ready", "Scheduled search permitted.");
  const started = runs
    .filter((run) => run.search_id === searchId && run.scheduled_at !== null)
    .toSorted(
      (a, b) =>
        Date.parse(b.scheduled_at ?? b.created_at) - Date.parse(a.scheduled_at ?? a.created_at),
    )[0];
  if (timing.mode === "daily" || (plan.quiet_hours.enabled && !plan.guard_required)) {
    const times = plan.times;
    const daily = { mode: "daily" as const, times };
    if (!dailyTimeDue(daily, plan.quiet_hours, now))
      return result(
        false,
        "not_due",
        "The next saved daily search time has not arrived. Missed times are skipped.",
        nextLocalTime(times, plan.timezone, now),
      );
    if (
      started?.scheduled_at &&
      localSlot(daily, plan.timezone, Date.parse(started.scheduled_at)) ===
        localSlot(daily, plan.timezone, now)
    )
      return result(
        false,
        "already_started",
        "This daily search time has already been started.",
        nextLocalTime(times, plan.timezone, now),
      );
  } else if (started?.scheduled_at) {
    const due =
      Date.parse(started.scheduled_at) +
      (timing.interval_minutes - Math.min(5, timing.interval_minutes / 4)) * 60000;
    if (due > now)
      return result(
        false,
        "not_due",
        "The next check interval has not elapsed.",
        inQuietHours(due, plan.quiet_hours)
          ? nextLocalTime(
              plan.times.length ? plan.times : [plan.quiet_hours.end],
              plan.timezone,
              due,
            )
          : new Date(due).toISOString(),
      );
  }
  return result(true, "ready", "Scheduled search permitted.");
}
