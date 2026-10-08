import type { Action } from "@/lib/actions";
import { FormField as Field } from "@/components/ui/form-field";
import { Disclosure } from "@/components/ui/disclosure";
import { GOODFINDS_VERSION } from "@goodfinds/contracts/version";
import { scheduleIsActive } from "@goodfinds/contracts/monitoring";
import { BrowserSettings } from "@/features/settings/browser-settings";
import { LocationSettings } from "@/features/settings/location-settings";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { ResponsiveOverlay } from "@/components/ui/responsive-overlay";
import { Check, ChevronRight, LoaderCircle, SlidersHorizontal } from "lucide-react";
import { Monitoring } from "@/features/searches/monitoring";
import { SearchHours } from "@/features/settings/search-hours";
import type { SettingsPatch } from "@/lib/settings-presentation";
import { settingsSchema } from "@goodfinds/contracts/state";
import type { GoodfindsState } from "@goodfinds/contracts/state";

export function SettingsForm({
  state,
  busy,
  action,
}: {
  state: GoodfindsState;
  busy: boolean;
  action: Action;
}) {
  const [validation, setValidation] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [manage, setManage] = useState(false);
  const manageButton = useRef<HTMLButtonElement>(null);
  const config = state.config;
  const active = state.monitoring.filter(scheduleIsActive).length;
  const paused = state.monitoring.filter((item) => item.status === "paused").length;
  const unverified = state.monitoring.some((item) => item.status === "unverified");
  const summary =
    [
      active ? `${active} active` : "",
      paused ? `${paused} paused` : "",
      unverified ? "Check needed" : "",
    ]
      .filter(Boolean)
      .join(" · ") || "Monitoring off";

  async function save(settings: SettingsPatch): Promise<void> {
    const parsed = settingsSchema.safeParse(settings);
    if (!parsed.success) {
      setValidation("Couldn't save this setting. Check the value.");
      return;
    }
    setValidation("");
    setStatus("saving");
    const next = await action("save_goodfinds_settings", {
      snapshot_revision: state.revision,
      settings: parsed.data,
    });
    setStatus(next ? "saved" : "idle");
  }

  function saveNumber(key: "baseline_days" | "minimum_peer_listings", value: string) {
    const number = Number(value);
    const maximum = key === "baseline_days" ? 365 : 100;
    if (!value.trim() || !Number.isInteger(number) || number < 1 || number > maximum) {
      setValidation(`Enter a whole number from 1 to ${maximum}.`);
      return;
    }
    setValidation("");
    if (number !== config[key]) void save({ [key]: number });
  }

  const locationAction: Action = async (name, args) => {
    const next = await action(name, args);
    if (next) setStatus("saved");
    return next;
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Settings</h2>
        <output
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          aria-live="polite"
        >
          {status === "saving" ? (
            <>
              <LoaderCircle className="size-3 animate-spin" aria-hidden="true" /> Saving…
            </>
          ) : status === "saved" ? (
            <>
              <Check className="size-3" aria-hidden="true" /> Saved
            </>
          ) : null}
        </output>
      </div>
      <div className="space-y-6 rounded-xl border p-5 @lg:p-6">
        <LocationSettings state={state} busy={busy} action={locationAction} />
        <section className="border-t pt-5 space-y-2">
          <Label htmlFor="journey-checks">Check driving times</Label>
          <NativeSelect
            id="journey-checks"
            value={config.journey_checks_enabled ? "on" : "off"}
            disabled={busy}
            onChange={(event) => {
              void save({ journey_checks_enabled: event.currentTarget.value === "on" });
            }}
          >
            <NativeSelectOption value="on">On</NativeSelectOption>
            <NativeSelectOption value="off">Off</NativeSelectOption>
          </NativeSelect>
          <p className="text-sm text-muted-foreground">
            Uses Google Maps with your starting point and destination. Times may vary with the
            pickup address and traffic.
          </p>
        </section>
        <div className="border-t pt-5">
          <BrowserSettings
            state={state}
            busy={busy}
            save={save}
            refresh={() => action("get_goodfinds_workspace", {})}
          />
        </div>
        <section
          aria-labelledby="monitoring-heading"
          className="flex items-center justify-between gap-3 border-t pt-5"
        >
          <div>
            <h3 id="monitoring-heading" className="font-medium">
              Monitoring
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">{summary}</p>
          </div>
          <Button
            ref={manageButton}
            type="button"
            size="sm"
            disabled={busy || !state.monitoring.length}
            onClick={() => setManage(true)}
          >
            Manage <ChevronRight aria-hidden="true" />
          </Button>
        </section>
        <SearchHours
          key={JSON.stringify(config.schedule.quiet_hours)}
          hours={config.schedule.quiet_hours}
          interval={config.schedule.interval_minutes}
          busy={busy || status === "saving"}
          save={save}
        />
        <Disclosure
          title={
            <span className="flex items-center gap-2">
              <SlidersHorizontal className="size-4" aria-hidden="true" />
              Price comparisons
            </span>
          }
        >
          <fieldset disabled={busy} className="mt-5 grid gap-5 @lg:grid-cols-2">
            <Field
              id="settings-baseline"
              label="Compare past prices (days)"
              hint="How far back to compare prices."
            >
              <Input
                key={config.baseline_days}
                id="settings-baseline"
                type="number"
                min={1}
                max={365}
                step={1}
                defaultValue={config.baseline_days}
                onBlur={(event) => saveNumber("baseline_days", event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </Field>
            <Field
              id="settings-peers"
              label="Minimum similar listings"
              hint="Minimum needed for a comparison."
            >
              <Input
                key={config.minimum_peer_listings}
                id="settings-peers"
                type="number"
                min={1}
                max={100}
                step={1}
                defaultValue={config.minimum_peer_listings}
                onBlur={(event) => saveNumber("minimum_peer_listings", event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </Field>
          </fieldset>
        </Disclosure>
        {validation && (
          <p role="alert" className="text-sm">
            {validation}
          </p>
        )}
      </div>
      <p
        className="border-t pt-4 text-center text-xs text-muted-foreground"
        aria-label="Goodfinds version"
      >
        Goodfinds · Version {GOODFINDS_VERSION}
      </p>
      <ResponsiveOverlay
        open={manage}
        onOpenChange={setManage}
        title="Monitoring"
        returnFocus={manageButton}
      >
        <div className="space-y-6">
          {state.monitoring.map((item) => (
            <section key={item.search_id}>
              <h3 className="font-medium">
                {state.searches.find((search) => search.id === item.search_id)?.name ?? "Search"}
              </h3>
              <Monitoring
                summary={item}
                revision={state.revision}
                busy={busy || state.mode === "sample"}
                action={action}
                showCheck={false}
              />
            </section>
          ))}
        </div>
      </ResponsiveOverlay>
    </section>
  );
}
