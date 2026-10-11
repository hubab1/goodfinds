import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { CalendarClock, Clock3, Timer } from "lucide-react";
import { scheduleIsActive } from "@goodfinds/contracts/monitoring";
import { RelativeTime } from "@/relative-time";
import { Empty } from "@/components/ui/empty-state";
import type { ViewProps } from "@/app/feature-props";

export function Activity({ state }: ViewProps) {
  const activeSchedules = state.monitoring.filter(scheduleIsActive).length;
  const unverified = state.monitoring.some((item) => item.status === "unverified");
  const status = activeSchedules
    ? `${activeSchedules} active`
    : unverified
      ? "Needs checking"
      : "Off";
  return (
    <section className="space-y-5">
      <PageHeader title="Activity" subtitle="Your recent searches and upcoming checks." />
      <dl
        aria-label="Search status"
        className="grid overflow-hidden rounded-xl border bg-card @lg:grid-cols-3"
      >
        <div className="flex min-w-0 items-center justify-between gap-3 border-b p-4 @lg:block @lg:border-r @lg:border-b-0">
          <dt className="flex items-center gap-2 text-xs text-muted-foreground">
            <Clock3 className="size-4 shrink-0" aria-hidden="true" /> Last checked
          </dt>
          <dd className="text-sm font-medium tabular-nums @lg:mt-1 @lg:pl-6">
            <RelativeTime value={state.monitor.last_run_at} />
          </dd>
        </div>
        <div className="flex min-w-0 items-center justify-between gap-3 border-b p-4 @lg:block @lg:border-r @lg:border-b-0">
          <dt className="flex items-center gap-2 text-xs text-muted-foreground">
            <CalendarClock className="size-4 shrink-0" aria-hidden="true" /> Automatic searches
          </dt>
          <dd className="text-sm font-medium @lg:mt-1 @lg:pl-6">{status}</dd>
        </div>
        <div className="flex min-w-0 items-center justify-between gap-3 p-4 @lg:block">
          <dt className="flex items-center gap-2 text-xs text-muted-foreground">
            <Timer className="size-4 shrink-0" aria-hidden="true" /> Next check
          </dt>
          <dd className="text-sm font-medium tabular-nums @lg:mt-1 @lg:pl-6">
            {unverified ? (
              "Needs checking"
            ) : activeSchedules && state.monitor.next_run_at ? (
              <RelativeTime value={state.monitor.next_run_at} />
            ) : activeSchedules ? (
              "Not confirmed"
            ) : (
              "None planned"
            )}
          </dd>
        </div>
      </dl>
      <h3 className="font-semibold">Recent checks</h3>
      {state.activity.length ? (
        <Card className="gap-0 py-0 shadow-none">
          <CardContent className="divide-y px-4">
            {state.activity.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between gap-3 py-4 text-sm">
                <div>
                  <p className="font-medium">
                    {entry.observed_count} {entry.mode === "synthetic" ? "sample " : ""}
                    {entry.observed_count === 1 ? "listing" : "listings"} checked
                  </p>
                  <p className="mt-1 text-xs">
                    <RelativeTime value={entry.evaluated_at} />
                  </p>
                </div>
                <Badge variant="outline">
                  {entry.status === "failed"
                    ? "Couldn’t check"
                    : entry.status === "partial"
                      ? "Incomplete"
                      : "Completed"}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : (
        <Empty title="No checks yet">
          <p className="text-sm">Run a search to start your history.</p>
        </Empty>
      )}
    </section>
  );
}
