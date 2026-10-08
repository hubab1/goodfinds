import { Menu, MenuTrigger, MenuContent, MenuItem } from "@/components/ui/menu";
import { Switch } from "@/components/ui/checkbox";
import { MARKETPLACES } from "@goodfinds/contracts/integrations";
import type { Marketplace } from "@goodfinds/contracts/integrations";
import type { ConnectionCheckRun } from "@goodfinds/contracts/connection-checks";
import { connectionCheckActive } from "@goodfinds/contracts/connection-checks";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { GoodfindsState } from "@goodfinds/contracts/state";
import { Ellipsis, LoaderCircle, RefreshCw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { cancelConnectionCheck, readConnectionCheck, startConnectionCheck } from "@/lib/client";
import {
  deviceBrowserLabel,
  marketplaceBrowser,
  marketplaceConnection,
} from "@/lib/settings-presentation";
import type { SettingsPatch } from "@/lib/settings-presentation";
import { MarketplaceLogo } from "@/marketplace-logo";
import "@/features/settings/settings.css";

function MarketplaceOptions({
  name,
  disabled,
  check,
}: {
  name: string;
  disabled: boolean;
  check: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger render={<Button size="icon-sm" />} aria-label={`Options for ${name}`}>
        <Ellipsis aria-hidden="true" />
      </MenuTrigger>
      <MenuContent>
        <MenuItem disabled={disabled} onClick={check}>
          <RefreshCw aria-hidden="true" /> Recheck
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export function BrowserSettings({
  state,
  busy,
  save,
  refresh,
}: {
  state: GoodfindsState;
  busy: boolean;
  save?: (settings: SettingsPatch) => Promise<void>;
  refresh?: () => Promise<unknown>;
}) {
  const [now, setNow] = useState(Date.now);
  const [run, setJob] = useState<ConnectionCheckRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [startingTargets, setStartingTargets] = useState<Marketplace[]>([]);
  const [message, setMessage] = useState("");
  const startingRef = useRef(false);
  const checking = starting || connectionCheckActive(run);
  const activeRunId = connectionCheckActive(run) ? run?.id : undefined;
  const disabled = busy || checking;
  const sample = state.mode === "sample";
  const enabled = MARKETPLACES.filter(
    (platform) => state.config.platforms[platform.id]?.enabled !== false,
  );
  const currentJob =
    connectionCheckActive(run) ||
    run?.targets.every(
      (target) =>
        state.config.platforms[target.marketplace]?.enabled !== false &&
        marketplaceBrowser(state, target.marketplace) === target.browser &&
        (target.browser !== "external" || target.browser_id === (state.device_browser?.id ?? null)),
    )
      ? run
      : null;
  const refreshState = useEffectEvent(() => refresh?.());

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let active = true;
    if (!sample && state.access_context !== "unknown")
      void readConnectionCheck(state.mode)
        .then((result) => {
          if (active) setJob(result.run);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [state.mode, state.access_context, sample]);
  useEffect(() => {
    if (!activeRunId) return undefined;
    let active = true;
    let pending = false;
    const poll = async () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      try {
        const result = await readConnectionCheck(state.mode, activeRunId);
        if (!active) return;
        setJob(result.run);
        if (result.run?.status === "complete") await refreshState();
      } catch {
        if (active) setMessage("Couldn't refresh the check. Try again.");
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(() => void poll(), 2_000);
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [activeRunId, state.mode]);

  async function check(marketplaces?: Marketplace[]) {
    if (startingRef.current || disabled || sample) return;
    startingRef.current = true;
    setStartingTargets(marketplaces ?? enabled.map((platform) => platform.id));
    setStarting(true);
    setMessage("");
    try {
      const result = await startConnectionCheck(state.mode, state.revisions.settings, marketplaces);
      setJob(result.run);
      if (result.run?.status === "complete") await refresh?.();
    } catch {
      setMessage("Couldn't start the check. Try again.");
    } finally {
      startingRef.current = false;
      setStarting(false);
      setStartingTargets([]);
    }
  }
  async function stop() {
    if (!run) return;
    try {
      const result = await cancelConnectionCheck(state.mode, run.id);
      setJob(result.run);
      setMessage("");
    } catch {
      setMessage("Couldn't stop the check. Try again.");
    }
  }

  const browserLabel = deviceBrowserLabel(state);
  return (
    <section aria-labelledby="browser-heading" className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 id="browser-heading" className="font-medium">
          Marketplaces
        </h3>
        <Button
          type="button"
          size="sm"
          disabled={busy || starting || sample || !enabled.length}
          onClick={() => void (checking ? stop() : check())}
        >
          {checking ? <Square aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
          {checking ? "Stop" : "Check"}
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Label htmlFor="settings-browser" className="text-sm text-muted-foreground">
          Preferred browser
        </Label>
        <NativeSelect
          id="settings-browser"
          name="browser_preference"
          value={state.config.browser_preference}
          disabled={disabled || !save}
          size="sm"
          onChange={(event) => {
            const browser = event.currentTarget.value;
            if (browser === "in_app" || browser === "external")
              void save?.({ browser_preference: browser });
          }}
        >
          <NativeSelectOption value="in_app">In-app browser</NativeSelectOption>
          <NativeSelectOption value="external">{browserLabel}</NativeSelectOption>
        </NativeSelect>
      </div>
      <div className="settings-marketplaces">
        <div className="settings-marketplace-head" aria-hidden="true">
          <span>Marketplace</span>
          <span>Status</span>
          <span>Browser</span>
          <span />
        </div>
        {MARKETPLACES.map((platform) => {
          const preference = state.config.platforms[platform.id] ?? {
            enabled: true,
            browser: "default" as const,
          };
          const inProgress =
            checking &&
            (starting
              ? startingTargets.includes(platform.id)
              : run?.targets.some((target) => target.marketplace === platform.id));
          const status = inProgress
            ? starting
              ? "Starting…"
              : run?.status === "queued"
                ? "Waiting…"
                : "Checking…"
            : marketplaceConnection(state, platform.id, now);
          function update(settings: Partial<typeof preference>) {
            void save?.({
              platforms: {
                ...state.config.platforms,
                [platform.id]: { ...preference, ...settings },
              },
            });
          }
          return (
            <div key={platform.id} className="settings-marketplace-row" aria-label={platform.name}>
              <label
                className="settings-marketplace-name"
                htmlFor={`platform-${platform.id}-enabled`}
              >
                <Switch
                  id={`platform-${platform.id}-enabled`}
                  aria-checked={preference.enabled}
                  aria-label={`Use ${platform.name}`}
                  checked={preference.enabled}
                  disabled={disabled || !save}
                  onChange={(event) => update({ enabled: event.currentTarget.checked })}
                />
                <MarketplaceLogo source={platform.id} className="size-5" />
                <span className="truncate text-sm font-medium">{platform.name}</span>
              </label>
              <output className="settings-marketplace-status text-xs text-muted-foreground">
                {inProgress && <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />}
                {status}
              </output>
              <div className="settings-marketplace-browser">
                <Label className="sr-only" htmlFor={`platform-${platform.id}-browser`}>
                  Browser
                </Label>
                <NativeSelect
                  id={`platform-${platform.id}-browser`}
                  name={`platform-${platform.id}-browser`}
                  value={preference.browser}
                  size="sm"
                  className="w-full"
                  disabled={disabled || !save || !preference.enabled}
                  onChange={(event) => {
                    const browser = event.currentTarget.value;
                    if (browser === "default" || browser === "in_app" || browser === "external")
                      update({ browser });
                  }}
                >
                  <NativeSelectOption value="default">Use preferred browser</NativeSelectOption>
                  <NativeSelectOption value="in_app">In-app browser</NativeSelectOption>
                  <NativeSelectOption value="external">{browserLabel}</NativeSelectOption>
                </NativeSelect>
              </div>
              <div className="settings-marketplace-options">
                <MarketplaceOptions
                  name={platform.name}
                  disabled={disabled || sample || !preference.enabled}
                  check={() => void check([platform.id])}
                />
              </div>
            </div>
          );
        })}
      </div>
      {(message || currentJob || sample) && (
        <output className="block text-xs text-muted-foreground" aria-live="polite">
          {message ||
            (sample
              ? "Checks are off in the sample workspace."
              : checking
                ? "Checking connections…"
                : currentJob?.message)}
        </output>
      )}
    </section>
  );
}
