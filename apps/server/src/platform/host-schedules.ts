import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import type { HostScheduleObservation, MonitoringRecord } from "@goodfinds/contracts/monitoring";
import { iso } from "../workspace/model.ts";

export function codexAutomationsDirectory(): string {
  return resolve(process.env["CODEX_HOME"] || resolve(homedir(), ".codex"), "automations");
}

const automationSchema = z.object({
  id: z.string(),
  kind: z.literal("heartbeat"),
  status: z.enum(["ACTIVE", "PAUSED"]),
  rrule: z.string(),
  target_thread_id: z.uuid(),
  timezone: z.string().optional(),
});

function intervalMinutes(rule: string): number | null {
  const fields = rule.replace(/^RRULE:/, "").split(";");
  if (fields.some((field) => !/^(FREQ=(MINUTELY|HOURLY|DAILY)|INTERVAL=[1-9]\d*)$/.test(field)))
    return null;
  const entries = fields.map((field) => {
    const [key, value] = field.split("=");
    return [key ?? "", value ?? ""] as const;
  });
  if (new Set(entries.map(([key]) => key)).size !== entries.length) return null;
  const values = new Map(entries);
  const unit =
    values.get("FREQ") === "MINUTELY"
      ? 1
      : values.get("FREQ") === "HOURLY"
        ? 60
        : values.get("FREQ") === "DAILY"
          ? 1440
          : 0;
  const minutes = unit * Number(values.get("INTERVAL") ?? 1);
  return Number.isSafeInteger(minutes) && minutes >= 15 && minutes <= 1440 ? minutes : null;
}

// Read only the IDs already linked to this workspace. The host remains responsible for
// creating and changing schedules; reading its current state never rewrites a receipt.
export function observeHostSchedules(
  records: MonitoringRecord[],
  directory: string | null,
  now: number,
): Map<string, HostScheduleObservation> {
  const observations = new Map<string, HostScheduleObservation>();
  const byAutomation = new Map<string, HostScheduleObservation>();
  if (directory === null) return observations;
  for (const record of records) {
    const schedule = record.schedule;
    if (!schedule?.automation_id) continue;
    const cached = byAutomation.get(`${schedule.automation_id}:${schedule.thread_id}`);
    if (cached) {
      observations.set(record.search_id, cached);
      continue;
    }
    const observation = (
      status: HostScheduleObservation["status"],
      evidence: string,
      interval_minutes: number | null = null,
    ) =>
      observations.set(record.search_id, {
        status,
        evidence,
        interval_minutes,
        checked_at: iso(now),
        rrule: null,
        timezone: null,
      });
    // Cache by both identity and thread; a mismatched binding cannot share verification.
    const remember = () => {
      const value = observations.get(record.search_id);
      if (value) byAutomation.set(`${schedule.automation_id}:${schedule.thread_id}`, value);
    };
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(schedule.automation_id)) {
      observation("unavailable", "This schedule needs verification through the host.");
      continue;
    }
    try {
      if (!existsSync(directory)) {
        observation("unavailable", "The host's schedule status is unavailable.");
        continue;
      }
      const path = resolve(directory, schedule.automation_id, "automation.toml");
      const automation = automationSchema.parse(Bun.TOML.parse(readFileSync(path, "utf8")));
      if (
        automation.id !== schedule.automation_id ||
        automation.target_thread_id !== schedule.thread_id
      ) {
        observation("unavailable", "The linked schedule's identity or chat has changed.");
        continue;
      }
      const interval = intervalMinutes(automation.rrule);
      observation(
        automation.status === "ACTIVE" ? "active" : "paused",
        "Checked the linked Codex automation.",
        interval,
      );
      const observed = observations.get(record.search_id);
      if (observed) {
        observed.rrule = automation.rrule;
        observed.timezone = automation.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      }
      remember();
    } catch (error) {
      const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
      observation(
        missing ? "removed" : "unavailable",
        missing
          ? "The linked schedule no longer exists."
          : "The linked schedule could not be read or verified.",
      );
      remember();
    }
  }
  return observations;
}
