import { Checkbox } from "@/components/ui/checkbox";
import { useState } from "react";
import type { QuietHours } from "@goodfinds/contracts/search-timing";
import { quietHoursSchema } from "@goodfinds/contracts/search-timing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SettingsPatch } from "@/lib/settings-presentation";

export function SearchHours({
  hours,
  interval,
  busy,
  save,
}: {
  hours: QuietHours;
  interval: number;
  busy: boolean;
  save: (patch: SettingsPatch) => Promise<void>;
}) {
  const [draft, setDraft] = useState(hours);
  const [error, setError] = useState("");
  const changed = JSON.stringify(hours) !== JSON.stringify(draft);
  return (
    <section className="space-y-4 border-t pt-5" aria-labelledby="search-hours-heading">
      <div>
        <h3 id="search-hours-heading" className="font-medium">
          Search hours
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose when automatic searches take a break. You can still use Search now during quiet
          hours.
        </p>
      </div>
      <fieldset disabled={busy} className="space-y-4">
        <label
          htmlFor="quiet-hours-enabled"
          className="flex items-center gap-2 text-sm font-medium"
        >
          <Checkbox
            id="quiet-hours-enabled"
            role="switch"
            aria-checked={draft.enabled}
            checked={draft.enabled}
            onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
          />
          Quiet hours
        </label>
        {draft.enabled && (
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="quiet-hours-start">Pause from</Label>
              <Input
                id="quiet-hours-start"
                type="time"
                value={draft.start}
                onChange={(event) => setDraft({ ...draft, start: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="quiet-hours-end">Resume at</Label>
              <Input
                id="quiet-hours-end"
                type="time"
                value={draft.end}
                onChange={(event) => setDraft({ ...draft, end: event.target.value })}
              />
            </div>
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="search-timezone">Time zone</Label>
          <Input
            id="search-timezone"
            value={draft.timezone}
            placeholder="Europe/London"
            onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Used for quiet hours and daily search times, including clock changes.
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          {draft.enabled
            ? `Scheduled searches pause ${draft.start}–${draft.end} (${draft.timezone}).`
            : "Scheduled searches may run at any time."}
        </p>
        {error && (
          <p role="alert" className="text-sm">
            {error}
          </p>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!changed}
          onClick={() => {
            const parsed = quietHoursSchema.safeParse(draft);
            if (!parsed.success) {
              setError("Choose valid times, a different start and end, and a valid time zone.");
              return;
            }
            setError("");
            void save({ quiet_hours: parsed.data });
          }}
        >
          Save search hours
        </Button>
        <div className="space-y-2 pt-2">
          <Label htmlFor="default-search-interval">Search every (minutes)</Label>
          <Input
            key={interval}
            id="default-search-interval"
            type="number"
            min={15}
            max={1440}
            step={15}
            defaultValue={interval}
            onBlur={(event) => {
              const minutes = Number(event.currentTarget.value);
              if (!Number.isInteger(minutes) || minutes < 15 || minutes > 1440) {
                setError("Enter a number of minutes from 15 to 1440.");
                return;
              }
              setError("");
              if (minutes !== interval) void save({ interval_minutes: minutes });
            }}
          />
          <p className="text-xs text-muted-foreground">
            Default for new searches. Each search can have its own schedule.
          </p>
        </div>
      </fieldset>
    </section>
  );
}
