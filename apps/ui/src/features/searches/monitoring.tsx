import type { MonitoringSummary } from "@goodfinds/contracts/monitoring";
import { monitoringRequest } from "@goodfinds/contracts/monitoring";
import { Button } from "@/components/ui/button";
import { HostAction } from "@/host-action";
import type { Action } from "@/lib/actions";
import { RelativeTime } from "@/relative-time";

export function Monitoring({
  summary,
  revision,
  busy,
  action,
  showCheck = true,
}: {
  summary: MonitoringSummary;
  revision: string;
  busy: boolean;
  action: Action;
  showCheck?: boolean;
}) {
  const active = summary.status === "active" || summary.status === "quiet";
  const nextSearchAt = summary.next_search_at ?? summary.schedule?.next_run_at;
  return (
    <div className="space-y-3" aria-label="Recurring search">
      <div>
        <h4 className="text-sm font-medium">{summary.label}</h4>
        <p className="mt-1 text-xs leading-relaxed">
          {active
            ? `${summary.plan.description}. ${summary.quiet_now ? "Scheduled searches are resting during quiet hours." : "Your computer needs to be awake with the host app running."}`
            : summary.status === "choice_needed"
              ? "Search now runs once. Choose Keep watching for automatic checks."
              : summary.status === "setup_needed"
                ? summary.schedule?.status === "removed"
                  ? "This schedule was removed. Keep watching to set it up again."
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
                        : "Recurring checks are not active for this search."}
        </p>
      </div>
      {summary.plan.excluded_times.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Skipped during quiet hours: {summary.plan.excluded_times.join(", ")}. Change those times
          or explicitly allow overnight checks for this search.
        </p>
      )}
      {summary.quiet_now && summary.next_allowed_at && (
        <p className="text-xs text-muted-foreground">
          Next search <RelativeTime value={summary.next_allowed_at} />.
        </p>
      )}
      {summary.schedule && (
        <p className="text-xs leading-relaxed">
          Schedule checked:{" "}
          <RelativeTime value={summary.host_schedule?.checked_at ?? summary.schedule.verified_at} />
          .
          {active &&
            (summary.schedule.last_run_at ? (
              <>
                {" "}
                Last scheduled run: <RelativeTime value={summary.schedule.last_run_at} />.
              </>
            ) : (
              " No scheduled run verified yet."
            ))}
          {active && nextSearchAt && (
            <>
              {" "}
              Next check: <RelativeTime value={nextSearchAt} />.
            </>
          )}
        </p>
      )}
      <div className="flex flex-wrap items-start gap-2">
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
        {["choice_needed", "saved", "setup_needed", "blocked", "paused"].includes(
          summary.status,
        ) && (
          <HostAction disabled={busy} request={monitoringRequest(summary.search_id, "search")}>
            {summary.next_action === "resume"
              ? "Resume monitoring"
              : summary.next_action === "update"
                ? "Update monitoring"
                : "Keep watching"}
          </HostAction>
        )}
        {["active", "quiet", "stop_needed"].includes(summary.status) && (
          <HostAction disabled={busy} request={monitoringRequest(summary.search_id, "pause")}>
            Stop monitoring
          </HostAction>
        )}
        {summary.schedule && showCheck && (
          <HostAction disabled={busy} request={monitoringRequest(summary.search_id, "check")}>
            Check schedule
          </HostAction>
        )}
      </div>
    </div>
  );
}
