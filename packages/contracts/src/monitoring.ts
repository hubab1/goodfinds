import { z } from "zod";
import {
  searchTimingSchema,
  quietHoursSchema,
  schedulePlanSchema,
  schedulePlan,
  defaultQuietHours,
  inQuietHours,
  nextLocalTime,
  canonicalRule,
} from "./search-timing.ts";
import type { QuietHours } from "./search-timing.ts";
import type { DispatcherSummary } from "./scheduled-dispatch.ts";

const interval = z.number().int().min(15).max(1440);
const threadId = z.uuid();
export const monitoringPreferenceSchema = z
  .object({
    search_id: z.string().min(1),
    preference: z.enum(["once", "recurring"]),
    interval_minutes: interval.optional(),
    timing: searchTimingSchema.optional(),
    allow_quiet_hours: z.boolean().optional(),
  })
  .strict()
  .refine(
    (request) => request.interval_minutes === undefined || request.timing === undefined,
    "Choose an interval or specific times, not both",
  );
const hostScheduleReportBaseSchema = z
  .object({
    search_id: z.string().min(1),
    automation_id: z.string().trim().min(1).max(200).nullable(),
    thread_id: threadId,
    status: z.enum(["active", "paused", "removed", "blocked"]),
    interval_minutes: interval,
    rrule: z.string().min(1).max(2000).optional(),
    timezone: quietHoursSchema.shape.timezone.optional(),
    evidence: z.string().trim().min(1).max(2000),
    next_run_at: z.iso.datetime({ offset: true }).nullable().default(null),
    last_run_at: z.iso.datetime({ offset: true }).nullable().default(null),
  })
  .strict();
export const hostScheduleReportSchema = hostScheduleReportBaseSchema.refine(
  (report) => report.status === "blocked" || report.automation_id !== null,
  "A verified schedule needs its host automation ID",
);
export const monitoringRecordSchema = z
  .object({
    search_id: z.string().min(1),
    preference: z.enum(["undecided", "once", "recurring"]),
    interval_minutes: interval,
    timing: searchTimingSchema.nullable().default(null),
    allow_quiet_hours: z.boolean().default(false),
    interruption: z.string().nullable().default(null),
    last_scheduled_run_at: z.iso.datetime({ offset: true }).nullable().default(null),
    schedule: hostScheduleReportBaseSchema
      .omit({ search_id: true })
      .extend({
        verified_at: z.iso.datetime({ offset: true }),
      })
      .nullable()
      .default(null),
  })
  .strict();
export const monitoringRecordsSchema = z
  .array(monitoringRecordSchema)
  .max(50)
  .default([])
  .refine(
    (records) => new Set(records.map((item) => item.search_id)).size === records.length,
    "Monitoring preferences must be unique per search",
  );
export type MonitoringRecord = z.infer<typeof monitoringRecordSchema>;

export const hostScheduleObservationSchema = z.object({
  status: z.enum(["active", "paused", "removed", "unavailable"]),
  checked_at: z.iso.datetime({ offset: true }),
  interval_minutes: interval.nullable(),
  evidence: z.string(),
  rrule: z.string().nullable().default(null),
  timezone: z.string().nullable().default(null),
});
export type HostScheduleObservation = z.infer<typeof hostScheduleObservationSchema>;

export const monitoringSummarySchema = z.object({
  search_id: z.string(),
  preference: z.enum(["undecided", "once", "recurring"]),
  interval_minutes: interval,
  timing: searchTimingSchema,
  plan: schedulePlanSchema,
  quiet_now: z.boolean(),
  next_allowed_at: z.iso.datetime({ offset: true }).nullable(),
  status: z.enum([
    "choice_needed",
    "saved",
    "setup_needed",
    "active",
    "paused",
    "blocked",
    "stop_needed",
    "fulfilled",
    "unverified",
    "quiet",
  ]),
  label: z.string(),
  next_action: z.enum(["choose", "start", "resume", "update", "pause", "check", "none"]),
  schedule: monitoringRecordSchema.shape.schedule,
  host_schedule: hostScheduleObservationSchema.nullable().default(null),
  interruption: z.string().nullable().default(null),
  dispatcher_id: z.uuid().nullable().default(null),
  next_search_at: z.iso.datetime().nullable().default(null),
});
export type MonitoringSummary = z.infer<typeof monitoringSummarySchema>;

// The preference and the host's observed receipt are independent facts.
export function monitoringSummary(
  search: { id: string; enabled: boolean },
  records: MonitoringRecord[],
  defaultInterval: number,
  fulfilled = false,
  sample = false,
  host: HostScheduleObservation | null = null,
  quietHours: QuietHours = defaultQuietHours(),
  now = Date.now(),
  shared?: DispatcherSummary,
): MonitoringSummary {
  const record = records.find((item) => item.search_id === search.id);
  const preference = record?.preference ?? "undecided";
  const minutes = record?.interval_minutes ?? defaultInterval;
  const timing = record?.timing ?? { mode: "interval" as const, interval_minutes: minutes };
  const plan = schedulePlan(timing, quietHours, record?.allow_quiet_hours);
  const quietNow = inQuietHours(now, plan.quiet_hours);
  const rawReceipt = sample ? null : (shared?.dispatcher.schedule ?? record?.schedule ?? null);
  const receipt =
    rawReceipt && shared
      ? { ...rawReceipt, last_run_at: record?.last_scheduled_run_at ?? null }
      : rawReceipt;
  host = shared?.host_schedule ?? host;
  const schedule =
    receipt && host && host.status !== "unavailable"
      ? {
          ...receipt,
          status: host.status,
          interval_minutes: host.interval_minutes ?? receipt.interval_minutes,
          next_run_at: null,
          last_run_at: record?.last_scheduled_run_at ?? receipt.last_run_at,
        }
      : receipt;
  const interruption =
    host && host.status !== "unavailable" ? null : (record?.interruption ?? null);
  const result = (
    status: MonitoringSummary["status"],
    label: string,
    next_action: MonitoringSummary["next_action"],
  ): MonitoringSummary => ({
    search_id: search.id,
    preference,
    interval_minutes: minutes,
    timing,
    plan,
    quiet_now: quietNow,
    next_allowed_at:
      quietNow && plan.rrule
        ? nextLocalTime(plan.times.length ? plan.times : [plan.quiet_hours.end], plan.timezone, now)
        : null,
    status,
    label,
    next_action,
    schedule,
    host_schedule: sample ? null : host,
    interruption,
    dispatcher_id: shared?.dispatcher.id ?? null,
    next_search_at: nextLocalTime(plan.times, plan.timezone, now),
  });
  if (sample) return result("saved", "Sample search", "none");
  if (
    host?.status === "unavailable" &&
    (!shared || (search.enabled && !fulfilled && preference === "recurring"))
  )
    return result("unverified", "Schedule unverified", "check");
  if (fulfilled || !search.enabled || preference === "once") {
    if (schedule?.status === "active" && (!shared || shared.plan.search_ids.length === 0))
      return result("stop_needed", "Pause monitoring needed", "pause");
    if (fulfilled) return result("fulfilled", "Fulfilled", "none");
    return search.enabled
      ? result("saved", "Monitoring off", "none")
      : result("paused", "Paused", "none");
  }
  if (preference === "undecided") return result("choice_needed", "Monitoring off", "choose");
  if (schedule?.status === "paused") return result("paused", "Monitoring paused", "resume");
  if (host?.status === "active" && host.interval_minutes === null && !host.rrule)
    return result("setup_needed", "Schedule changed", "update");
  if (interruption || schedule?.status === "blocked")
    return result(
      "blocked",
      "Monitoring needs attention",
      schedule?.automation_id ? "update" : "start",
    );
  if (schedule?.status === "active") {
    const rule = host?.rrule ?? schedule.rrule;
    const zone = host?.timezone ?? schedule.timezone;
    const expectedRule = shared?.plan.rrule ?? plan.rrule;
    const matches =
      expectedRule !== null &&
      (!shared || shared.plan.supported) &&
      Boolean(
        rule && canonicalRule(rule) === canonicalRule(expectedRule) && zone === plan.timezone,
      );
    if (!matches)
      return result(
        "setup_needed",
        plan.rrule ? "Schedule update needed" : "No active search times",
        "update",
      );
    return quietNow
      ? result("quiet", "Quiet hours", "none")
      : result("active", "Monitoring active", "none");
  }
  return result(
    "setup_needed",
    schedule?.status === "removed" ? "Schedule removed" : "Monitoring setup needed",
    "start",
  );
}

export function scheduleIsActive(summary: MonitoringSummary): boolean {
  if (summary.host_schedule) return summary.host_schedule.status === "active";
  return (
    summary.status === "active" || summary.status === "quiet" || summary.status === "stop_needed"
  );
}

export function monitoringRequest(
  searchId: string,
  action: "search" | "pause" | "check" | "enable" | "disable",
): string {
  const intent =
    action === "search"
      ? "Keep watching this saved search. This request authorizes recurring checks at its saved cadence, defaulting to hourly, and respects quiet hours (22:00–08:00 by default)."
      : action === "pause"
        ? "Stop recurring checks for this saved search and keep its listings."
        : action === "enable" || action === "disable"
          ? `${action === "enable" ? "Resume" : "Pause"} this saved search and reconcile its linked recurring checks.`
          : "Check the actual host schedule for this saved search and reconcile its saved status.";
  const choice =
    action === "check"
      ? "Preserve the saved monitoring choice and enabled flag."
      : action === "enable" || action === "disable"
        ? `Preserve the monitoring choice and call set_goodfinds_search_enabled with enabled ${action === "enable" ? "true" : "false"} before reconciling the host schedule.`
        : `Save preference ${action === "search" ? "recurring" : "once"} with set_goodfinds_monitoring.`;
  return `Use Goodfinds's marketplace-shopping skill to change only search_id ${JSON.stringify(searchId)}. ${intent} Read get_goodfinds_search_context and references/evaluation-delivery.md. ${choice} Reconcile through get_goodfinds_dispatcher_context in the original buying chat. Join an existing compatible dispatcher using its compiled shared plan and preserve every peer's timing and monitoring choice. Pausing this search leaves other active members running; pause the host automation only when no members remain eligible. Reuse the automation ID, original thread and notification settings. Each shared wake-up uses request_goodfinds_scheduled_batch to reserve only due searches from the database. Verify the host result and record report_goodfinds_dispatcher_schedule with the fresh plan revision. A saved preference alone does not activate monitoring. A development/review request cannot activate a buyer's search. Preserve observed host pauses unless resuming is authorized. Search execution and seller contact are separate actions.`;
}
