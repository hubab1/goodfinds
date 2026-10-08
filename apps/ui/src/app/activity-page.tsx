import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { scheduleIsActive } from "@goodfinds/contracts/monitoring";
import { RelativeTime } from "@/relative-time";
import { Empty } from "@/components/ui/empty-state";
import type { ViewProps } from "@/app/feature-props";

export function Activity({ state }: ViewProps) {
  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold">Activity</h2>
        <p className="mt-1 text-sm">Search history</p>
      </div>
      <Card>
        <CardContent className="grid gap-5 py-5 @lg:grid-cols-3">
          <div>
            <h3 className="text-xs">Last checked</h3>
            <p className="mt-1 text-sm font-medium">
              <RelativeTime value={state.monitor.last_run_at} />
            </p>
          </div>
          <div>
            <h3 className="text-xs">Automatic searches</h3>
            <p className="mt-1 text-sm font-medium">
              {state.monitoring.filter(scheduleIsActive).length
                ? `${state.monitoring.filter(scheduleIsActive).length} active`
                : state.monitoring.some((item) => item.status === "unverified")
                  ? "Needs checking"
                  : "Off"}
            </p>
          </div>
          <div>
            <h3 className="text-xs">Monitoring updates</h3>
            <p className="mt-1 text-sm font-medium">
              {state.monitoring.some(scheduleIsActive)
                ? "In your buying chat"
                : state.monitoring.some((item) => item.status === "unverified")
                  ? "Needs checking"
                  : "No active schedule"}
            </p>
          </div>
        </CardContent>
      </Card>
      <h3 className="font-semibold">Recent checks</h3>
      {state.activity.length ? (
        <Card>
          <CardContent className="divide-y">
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
