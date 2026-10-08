import { z } from "zod";

export const clockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u);
export const timezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone }).format();
      return true;
    } catch {
      return false;
    }
  }, "Choose a valid time zone");
export const quietHoursSchema = z
  .object({
    enabled: z.boolean(),
    start: clockTimeSchema,
    end: clockTimeSchema,
    timezone: timezoneSchema,
  })
  .strict()
  .refine(
    (hours) => hours.start !== hours.end,
    "Quiet hours must have different start and end times",
  );
export type QuietHours = z.infer<typeof quietHoursSchema>;
export function defaultQuietHours(): QuietHours {
  return {
    enabled: true,
    start: "22:00",
    end: "08:00",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
}
export const searchTimingSchema = z.discriminatedUnion("mode", [
  z
    .object({ mode: z.literal("interval"), interval_minutes: z.number().int().min(15).max(1440) })
    .strict(),
  z
    .object({
      mode: z.literal("daily"),
      times: z
        .array(clockTimeSchema)
        .min(1)
        .max(12)
        .refine((times) => new Set(times).size === times.length, "Search times must be unique"),
    })
    .strict(),
]);
export type SearchTiming = z.infer<typeof searchTimingSchema>;

export const schedulePlanSchema = z.object({
  timing: searchTimingSchema,
  quiet_hours: quietHoursSchema,
  timezone: timezoneSchema,
  rrule: z.string().nullable(),
  guard_required: z.boolean(),
  description: z.string(),
  excluded_times: z.array(clockTimeSchema),
  times: z.array(clockTimeSchema),
});
export type SchedulePlan = z.infer<typeof schedulePlanSchema>;
export function minuteOfDay(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
}
function clockTime(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
export function isQuietMinute(minute: number, hours: QuietHours): boolean {
  if (!hours.enabled) return false;
  const start = minuteOfDay(hours.start),
    end = minuteOfDay(hours.end);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}
const formatters = new Map<string, Intl.DateTimeFormat>();
function localParts(at: number, timezone: string) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, formatter);
  }
  const values = new Map(formatter.formatToParts(at).map((part) => [part.type, part.value]));
  const date = `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
  const time = `${values.get("hour")}:${values.get("minute")}`;
  return { date, time, minute: minuteOfDay(time) };
}
export function inQuietHours(at: number, hours: QuietHours): boolean {
  return isQuietMinute(localParts(at, hours.timezone).minute, hours);
}

// Resolve wall-clock times using both offsets around a DST transition. A missing
// local time is skipped; a repeated time can return either actual occurrence.
function occurrences(date: string, time: string, zone: string): number[] {
  const wall = Date.parse(`${date}T${time}:00Z`);
  const offsets = new Set(
    [-36, 0, 36].map((hours) => {
      const at = wall + hours * 3600000;
      const parts = localParts(at, zone);
      return Date.parse(`${parts.date}T${parts.time}:00Z`) - at;
    }),
  );
  return [...offsets]
    .map((offset) => wall - offset)
    .filter((at) => {
      const parts = localParts(at, zone);
      return parts.date === date && parts.time === time;
    })
    .toSorted((a, b) => a - b);
}
export function nextLocalTime(times: string[], timezone: string, now: number): string | null {
  const day = localParts(now, timezone).date;
  for (let offset = 0; offset < 4; offset++) {
    const date = new Date(Date.parse(`${day}T12:00:00Z`) + offset * 86400000)
      .toISOString()
      .slice(0, 10);
    const future = times
      .flatMap((time) => occurrences(date, time, timezone))
      .filter((at) => at > now)
      .toSorted((a, b) => a - b)[0];
    if (future !== undefined) return new Date(future).toISOString();
  }
  return null;
}

export function dailyRule(minutes: number[]): string | null {
  const hours = [...new Set(minutes.map((minute) => Math.floor(minute / 60)))].toSorted(
    (a, b) => a - b,
  );
  const offsets = [...new Set(minutes.map((minute) => minute % 60))].toSorted((a, b) => a - b);
  const count = hours.length * offsets.length;
  const positions = minutes.map(
    (minute) =>
      hours.indexOf(Math.floor(minute / 60)) * offsets.length + offsets.indexOf(minute % 60) + 1,
  );
  const selected = positions.map((position) => (position <= 366 ? position : position - count - 1));
  if (selected.some((position) => Math.abs(position) > 366)) return null;
  return `FREQ=DAILY;BYHOUR=${hours.join(",")};BYMINUTE=${offsets.join(",")};BYSECOND=0${positions.length === count ? "" : `;BYSETPOS=${selected.join(",")}`}`;
}
export function schedulePlan(
  timing: SearchTiming,
  quiet: QuietHours,
  allowQuietHours = false,
): SchedulePlan {
  const hours = { ...quiet, enabled: quiet.enabled && !allowQuietHours };
  let times: number[] = [],
    excluded: string[] = [];
  if (timing.mode === "daily") {
    excluded = timing.times.filter((time) => isQuietMinute(minuteOfDay(time), hours));
    times = timing.times
      .filter((time) => !excluded.includes(time))
      .map(minuteOfDay)
      .toSorted((a, b) => a - b);
  } else if (hours.enabled) {
    const start = minuteOfDay(hours.end);
    const duration = (minuteOfDay(hours.start) - start + 1440) % 1440;
    for (let elapsed = 0; elapsed < duration; elapsed += timing.interval_minutes)
      times.push((start + elapsed) % 1440);
    times.sort((a, b) => a - b);
  }
  let rule: string | null;
  let guard = false;
  if (timing.mode === "interval" && !hours.enabled) {
    rule =
      timing.interval_minutes % 60 === 0
        ? `FREQ=HOURLY;INTERVAL=${timing.interval_minutes / 60}`
        : `FREQ=MINUTELY;INTERVAL=${timing.interval_minutes}`;
  } else {
    rule = times.length ? dailyRule(times) : null;
    if (!rule && times.length && timing.mode === "interval") {
      const allowedHours = Array.from({ length: 24 }, (_, hour) => hour).filter((hour) =>
        Array.from({ length: 60 }, (_, minute) => hour * 60 + minute).some(
          (minute) => !isQuietMinute(minute, hours),
        ),
      );
      rule = `FREQ=MINUTELY;INTERVAL=${timing.interval_minutes};BYHOUR=${allowedHours.join(",")}`;
      guard = true;
    }
  }
  const cadence =
    timing.mode === "daily"
      ? `Daily at ${times.map(clockTime).join(", ") || "no permitted times"}`
      : `Every ${timing.interval_minutes === 60 ? "hour" : `${timing.interval_minutes} minutes`}`;
  return {
    timing,
    quiet_hours: hours,
    timezone: hours.timezone,
    rrule: rule,
    guard_required: guard,
    description: `${cadence}${hours.enabled ? ` · quiet ${hours.start}–${hours.end}` : " · any time"} (${hours.timezone})`,
    excluded_times: excluded,
    times: times.map(clockTime),
  };
}
export function canonicalRule(rule: string): string {
  const tokens = rule
    .replace(/^RRULE:/iu, "")
    .toUpperCase()
    .split(";");
  const keys = tokens.map((token) => token.split("=")[0]);
  // Reject duplicate fields instead of silently letting a later field overwrite
  // an earlier one and turn an invalid host rule into a verified schedule.
  if (
    new Set(keys).size !== keys.length ||
    tokens.some((token) => !/^[A-Z]+=[A-Z0-9,+-]+$/u.test(token))
  )
    return `INVALID:${rule}`;
  const fields = new Map(
    tokens.map((field) => {
      const [key = "", value = ""] = field.split("=");
      return [
        key,
        value
          .split(",")
          .toSorted((a, b) => Number(a) - Number(b))
          .join(","),
      ];
    }),
  );
  if (!fields.has("INTERVAL")) fields.set("INTERVAL", "1");
  if (!fields.has("BYSECOND")) fields.set("BYSECOND", "0");
  if (["HOURLY", "MINUTELY"].includes(fields.get("FREQ") ?? "") && fields.size === 3) {
    fields.set(
      "INTERVAL",
      String(Number(fields.get("INTERVAL")) * (fields.get("FREQ") === "HOURLY" ? 60 : 1)),
    );
    fields.set("FREQ", "MINUTELY");
  }
  return [...fields]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(";");
}
export function dailyTimeDue(timing: SearchTiming, quiet: QuietHours, now: number): boolean {
  if (timing.mode !== "daily") return true;
  const local = localParts(now, quiet.timezone);
  return timing.times.some(
    (time) =>
      local.minute >= minuteOfDay(time) &&
      local.minute - minuteOfDay(time) < 15 &&
      !isQuietMinute(minuteOfDay(time), quiet),
  );
}
export function localSlot(timing: SearchTiming, timezone: string, now: number): string | null {
  if (timing.mode !== "daily") return null;
  const local = localParts(now, timezone);
  const time = timing.times
    .filter((candidate) => minuteOfDay(candidate) <= local.minute)
    .toSorted()
    .at(-1);
  return time ? `${local.date}T${time}` : null;
}
