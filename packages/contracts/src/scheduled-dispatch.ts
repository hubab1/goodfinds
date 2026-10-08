import { z } from "zod";
import type { MonitoringRecord, HostScheduleObservation } from "./monitoring.ts";
import { hostScheduleObservationSchema } from "./monitoring.ts";
import {
  schedulePlan,
  canonicalRule,
  dailyRule,
  minuteOfDay,
  nextLocalTime,
  quietHoursSchema,
} from "./search-timing.ts";
import type { QuietHours } from "./search-timing.ts";

const searchIds = z
  .array(z.string().min(1))
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length, "Searches must be unique");
export const dispatcherReceiptSchema = z.object({
  automation_id: z.string().min(1).max(200).nullable(),
  thread_id: z.uuid(),
  status: z.enum(["active", "paused", "removed", "blocked"]),
  interval_minutes: z.number().int().min(15).max(1440),
  rrule: z.string().min(1).max(2000).optional(),
  timezone: quietHoursSchema.shape.timezone.optional(),
  evidence: z.string().trim().min(1).max(2000),
  next_run_at: z.iso.datetime({ offset: true }).nullable().default(null),
  last_run_at: z.iso.datetime({ offset: true }).nullable().default(null),
  verified_at: z.iso.datetime({ offset: true }),
});
export const dispatcherRecordSchema = z
  .object({
    id: z.uuid(),
    thread_id: z.uuid(),
    host_id: z.string().min(1).max(200).default("local"),
    notification_policy: z.enum(["failed_runs_only"]).nullable().default(null),
    search_ids: searchIds,
    schedule: dispatcherReceiptSchema.nullable().default(null),
  })
  .strict()
  .refine(
    (d) => !d.schedule || d.schedule.thread_id === d.thread_id,
    "Keep the original buying chat",
  );
export const dispatcherRecordsSchema = z
  .array(dispatcherRecordSchema)
  .max(50)
  .default([])
  .refine((records) => {
    const ids = records.map((d) => d.id),
      members = records.flatMap((d) => d.search_ids);
    return new Set(ids).size === ids.length && new Set(members).size === members.length;
  }, "A search can belong to only one dispatcher");
export type DispatcherRecord = z.infer<typeof dispatcherRecordSchema>;
export const dispatcherReportSchema = z
  .object({
    plan_revision: z.string().regex(/^[a-f0-9]{64}$/u),
    dispatcher_id: z.uuid(),
    thread_id: z.uuid(),
    host_id: z.string().min(1).max(200).default("local"),
    notification_policy: z.enum(["failed_runs_only"]).nullable().default(null),
    search_ids: searchIds,
    schedule: dispatcherReceiptSchema.omit({ verified_at: true }),
  })
  .strict()
  .refine(
    (report) =>
      report.schedule.thread_id === report.thread_id &&
      (report.schedule.status === "blocked" || report.schedule.automation_id !== null),
    "Verify the original chat and host automation identity",
  );
export const dispatcherPlanSchema = z.object({
  search_ids: searchIds,
  times: z.array(z.string()),
  rrule: z.string().nullable(),
  timezone: z.string(),
  interval_minutes: z.number().int().min(15).max(1440),
  supported: z.boolean(),
  explanation: z.string(),
  next_wake_at: z.iso.datetime().nullable(),
  revision: z.string(),
});
export type DispatcherPlan = z.infer<typeof dispatcherPlanSchema>;
export const dispatcherSummarySchema = z.object({
  dispatcher: dispatcherRecordSchema,
  plan: dispatcherPlanSchema,
  host_schedule: hostScheduleObservationSchema.nullable(),
});
export type DispatcherSummary = z.infer<typeof dispatcherSummarySchema>;
export type DispatcherConfiguration = {
  searches: { id: string; enabled: boolean }[];
  monitoring: MonitoringRecord[];
  dispatchers: DispatcherRecord[];
  schedule: { interval_minutes: number; quiet_hours: QuietHours };
};

export function dispatcherForSearch(
  config: Pick<DispatcherConfiguration, "dispatchers">,
  searchId: string,
) {
  return config.dispatchers.find((d) => d.search_ids.includes(searchId));
}
export function dispatcherPlan(
  config: DispatcherConfiguration,
  ids: string[],
  fulfilled: Set<string>,
  now: number,
  revision: string,
): DispatcherPlan {
  const members = ids.filter(
    (id) =>
      config.searches.some((s) => s.id === id && s.enabled) &&
      !fulfilled.has(id) &&
      config.monitoring.some((m) => m.search_id === id && m.preference === "recurring"),
  );
  const plans = members
    .map((id) => {
      const m = config.monitoring.find((item) => item.search_id === id);
      return schedulePlan(
        m?.timing ?? {
          mode: "interval",
          interval_minutes: m?.interval_minutes ?? config.schedule.interval_minutes,
        },
        config.schedule.quiet_hours,
        m?.allow_quiet_hours,
      );
    })
    .filter((p) => p.rrule !== null);
  const times = [...new Set(plans.flatMap((p) => p.times))].toSorted();
  let rule: string | null = null;
  if (plans.length && plans.every((p) => p.times.length)) rule = dailyRule(times.map(minuteOfDay));
  else if (
    plans.length &&
    plans.every((p) => canonicalRule(p.rrule ?? "") === canonicalRule(plans[0]?.rrule ?? ""))
  )
    rule = plans[0]?.rrule ?? null;
  const supported = !plans.length || rule !== null;
  return {
    search_ids: members.filter((id) => {
      const m = config.monitoring.find((item) => item.search_id === id);
      return (
        schedulePlan(
          m?.timing ?? {
            mode: "interval",
            interval_minutes: m?.interval_minutes ?? config.schedule.interval_minutes,
          },
          config.schedule.quiet_hours,
          m?.allow_quiet_hours,
        ).rrule !== null
      );
    }),
    times,
    rrule: rule,
    timezone: config.schedule.quiet_hours.timezone,
    interval_minutes: plans.length
      ? Math.min(
          ...plans.map((p) => (p.timing.mode === "interval" ? p.timing.interval_minutes : 1440)),
        )
      : config.schedule.interval_minutes,
    supported,
    explanation: supported
      ? rule
        ? "Shared wake-ups cover the active searches; each search keeps its own timing."
        : "No active members have permitted search times."
      : "These continuous intervals cannot be combined exactly. Keep separate dispatcher groups for their timing plans.",
    next_wake_at: times.length
      ? nextLocalTime(times, config.schedule.quiet_hours.timezone, now)
      : null,
    revision,
  };
}

// The host adapter reads one shared automation, then projects its observation to members.
export function scheduleObservationRecords(
  records: MonitoringRecord[],
  dispatchers: DispatcherRecord[],
): MonitoringRecord[] {
  return [
    ...records,
    ...dispatchers.map((d) => ({
      search_id: `dispatcher:${d.id}`,
      preference: "recurring" as const,
      interval_minutes: d.schedule?.interval_minutes ?? 60,
      timing: null,
      allow_quiet_hours: false,
      interruption: null,
      last_scheduled_run_at: null,
      schedule: d.schedule,
    })),
  ];
}
export function sharedMonitoring(dispatchers: DispatcherSummary[], searchId: string) {
  return dispatchers.find((d) => d.dispatcher.search_ids.includes(searchId));
}
export function dispatcherMatches(summary: DispatcherSummary): boolean {
  const host = summary.host_schedule,
    receipt = summary.dispatcher.schedule;
  return (
    summary.plan.supported &&
    summary.plan.rrule !== null &&
    (host?.status ?? receipt?.status) === "active" &&
    Boolean(
      (host?.rrule ?? receipt?.rrule) &&
      canonicalRule(host?.rrule ?? receipt?.rrule ?? "") === canonicalRule(summary.plan.rrule) &&
      (host?.timezone ?? receipt?.timezone) === summary.plan.timezone,
    )
  );
}
export const dispatcherContextInputSchema = z
  .object({
    thread_id: z.uuid(),
    search_ids: searchIds.optional(),
    dispatcher_id: z.uuid().optional(),
  })
  .strict();
export const scheduledBatchSchema = z
  .object({ dispatcher_id: z.uuid(), thread_id: z.uuid(), request_id: z.uuid() })
  .strict();
export const scheduledBatchOutputSchema = z.object({
  dispatcher_id: z.uuid(),
  checked_at: z.iso.datetime(),
  reason: z.string(),
  runs: z.array(
    z.object({
      search_id: z.string(),
      run_id: z.uuid(),
      version: z.number(),
      phase: z.string(),
      worker_id: z.string().nullable(),
      agent_id: z.string().nullable(),
    }),
  ),
  skipped: z.array(z.object({ search_id: z.string(), reason: z.string() })),
});
export function dispatcherSummaries(
  config: DispatcherConfiguration,
  fulfilled: Set<string>,
  now: number,
  hosts: Map<string, HostScheduleObservation>,
  revision: (ids: string[]) => string,
): DispatcherSummary[] {
  return config.dispatchers.map((dispatcher) => ({
    dispatcher,
    plan: dispatcherPlan(
      config,
      dispatcher.search_ids,
      fulfilled,
      now,
      revision(dispatcher.search_ids),
    ),
    host_schedule: hosts.get(`dispatcher:${dispatcher.id}`) ?? null,
  }));
}
