import type { MonitoringSummary } from "@goodfinds/contracts/monitoring";
import { monitoringRequest } from "@goodfinds/contracts/monitoring";
import { Button } from "@/components/ui/button";
import { HostAction } from "@/host-action";
import type { Action } from "@/lib/actions";
import { RelativeTime } from "@/relative-time";
import { CalendarClock, CircleAlert, Pause, Play } from "lucide-react";
import "./monitoring.css";

export function monitoringStatus(summary: MonitoringSummary): string {
  if (summary.status === "active") return "On";
  if (summary.status === "quiet") return "Quiet hours";
  if (summary.status === "paused") return "Paused";
  if (summary.schedule?.status === "removed") return "Stopped";
  if (summary.status === "unverified") return "Not confirmed";
  if (["blocked", "stop_needed"].includes(summary.status)) return "Needs attention";
  if (summary.status === "fulfilled") return "Complete";
  return "Off";
}

export function MonitoringAction({
  summary,
  busy,
  compact = false,
}: {
  summary: MonitoringSummary;
  busy: boolean;
  compact?: boolean;
}) {
  const canStart = ["choice_needed", "saved", "setup_needed", "blocked", "paused"].includes(
    summary.status,
  );
  const canStop = ["active", "quiet", "stop_needed"].includes(summary.status);
  const canCheck = summary.status === "unverified";
  if (!canStart && !canStop && !canCheck) return null;
  const removed = summary.schedule?.status === "removed";
  const resume = removed || summary.status === "paused" || Boolean(summary.schedule);
  const update = !removed && summary.next_action === "update";
  const label = canStop
    ? compact
      ? "Pause"
      : "Pause checks"
    : canCheck
      ? compact
        ? "Check"
        : "Check status"
      : update
        ? compact
          ? "Update"
          : "Update schedule"
        : resume
          ? compact
            ? "Resume"
            : removed
              ? "Restore schedule"
              : "Resume checks"
          : compact
            ? "Start"
            : "Start checks";
  return (
    <HostAction
      key={`${summary.status}:${summary.preference}:${summary.schedule?.status}:${summary.plan.rrule}`}
      disabled={busy}
      icon={
        compact ? null : canStop ? (
          <Pause aria-hidden="true" />
        ) : canCheck ? (
          <CalendarClock aria-hidden="true" />
        ) : (
          <Play aria-hidden="true" />
        )
      }
      pendingLabel={
        canStop
          ? "Pausing…"
          : canCheck
            ? "Checking…"
            : update
              ? "Updating…"
              : resume
                ? "Resuming…"
                : "Starting…"
      }
      successMessage={
        compact ? "Awaiting confirmation" : "Request sent. Waiting for schedule confirmation."
      }
      request={monitoringRequest(
        summary.search_id,
        canStop ? "pause" : canCheck ? "check" : "resume",
      )}
      {...(compact
        ? { className: "search-schedule-button", containerClassName: "search-schedule-action" }
        : {})}
    >
      {label}
    </HostAction>
  );
}

export function Monitoring({
  summary,
  revision,
  busy,
  action,
  showCheck = true,
  showActions = true,
}: {
  summary: MonitoringSummary;
  revision: string;
  busy: boolean;
  action: Action;
  showCheck?: boolean;
  showActions?: boolean;
}) {
  const active = summary.status === "active" || summary.status === "quiet";
  const hours = summary.interval_minutes / 60;
  const cadence =
    summary.timing.mode === "interval" && Number.isInteger(hours)
      ? summary.plan.description.replace(
          /^Every \d+ mins/u,
          `Every ${hours} ${hours === 1 ? "hour" : "hours"}`,
        )
      : summary.plan.description;
  const nextSearchAt = summary.quiet_now
    ? summary.next_allowed_at
    : (summary.next_search_at ?? summary.schedule?.next_run_at);
  const canStart = ["choice_needed", "saved", "setup_needed", "blocked", "paused"].includes(
    summary.status,
  );
  const canStop = ["active", "quiet", "stop_needed"].includes(summary.status);
  const canCheck = Boolean(showCheck && summary.schedule);
  const StatusIcon =
    summary.status === "paused"
      ? Pause
      : ["blocked", "unverified", "stop_needed"].includes(summary.status)
        ? CircleAlert
        : CalendarClock;
  return (
    <div className="monitoring-panel" aria-label="Recurring search">
      <div className="monitoring-summary">
        <span className="monitoring-icon" aria-hidden="true">
          <StatusIcon size={16} />
        </span>
        <div className="min-w-0">
          <h4 className="text-sm font-medium">
            Automatic checks <span className="monitoring-status">{monitoringStatus(summary)}</span>
          </h4>
          <p className="mt-1 text-xs text-muted-foreground">{cadence}</p>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted-foreground">
            {active
              ? summary.quiet_now
                ? "Automatic checks resume after quiet hours."
                : "Your computer needs to be awake with the app running."
              : summary.status === "choice_needed"
                ? "Start checks to look for new listings automatically."
                : summary.status === "setup_needed"
                  ? summary.schedule?.status === "removed"
                    ? "The previous schedule was removed. Restore it using your saved timing; updates can continue in this chat if needed."
                    : summary.host_schedule?.status === "active"
                      ? "Update monitoring to apply your saved times and search hours."
                      : "The schedule needs to be set up or updated to match your search."
                  : summary.status === "stop_needed"
                    ? "Verify that the linked schedule has stopped before considering monitoring paused."
                    : summary.status === "blocked"
                      ? (summary.interruption ?? "Check the linked schedule to continue.")
                      : summary.status === "unverified"
                        ? "We couldn't confirm the schedule's current status. Check it before making changes."
                        : summary.status === "saved"
                          ? "Your criteria are saved. Recurring checks are off."
                          : summary.status === "paused"
                            ? "Resume when you’re ready to look for more."
                            : "Recurring checks are not active for this search."}
          </p>
        </div>
      </div>
      {showActions && (canStart || canStop || canCheck || summary.status === "unverified") && (
        <div className="monitoring-actions">
          {summary.status === "choice_needed" && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                void action(
                  "set_goodfinds_monitoring",
                  {
                    snapshot_revision: revision,
                    monitoring: { search_id: summary.search_id, preference: "once" },
                  },
                  "Saved as a one-off search",
                );
              }}
            >
              Search once
            </Button>
          )}
          <MonitoringAction summary={summary} busy={busy} />
          {canCheck && summary.status !== "unverified" && (
            <HostAction
              disabled={busy}
              icon={<CalendarClock aria-hidden="true" />}
              request={monitoringRequest(summary.search_id, "check")}
            >
              Check status
            </HostAction>
          )}
        </div>
      )}
      {(summary.schedule || (active && nextSearchAt)) && (
        <dl className="monitoring-facts text-xs">
          {summary.schedule && (
            <div>
              <dt className="text-muted-foreground">Schedule checked</dt>
              <dd>
                <RelativeTime
                  value={summary.host_schedule?.checked_at ?? summary.schedule.verified_at}
                />
              </dd>
            </div>
          )}
          {active && summary.schedule && (
            <div>
              <dt className="text-muted-foreground">Last scheduled check</dt>
              <dd>
                <RelativeTime value={summary.schedule.last_run_at} />
              </dd>
            </div>
          )}
          {active && nextSearchAt && (
            <div>
              <dt className="text-muted-foreground">Next check</dt>
              <dd>
                <RelativeTime value={nextSearchAt} />
              </dd>
            </div>
          )}
        </dl>
      )}
      {summary.plan.excluded_times.length > 0 && (
        <p className="col-span-full text-xs leading-relaxed text-muted-foreground">
          Skipped during quiet hours: {summary.plan.excluded_times.join(", ")}. Change those times
          or explicitly allow overnight checks for this search.
        </p>
      )}
    </div>
  );
}
