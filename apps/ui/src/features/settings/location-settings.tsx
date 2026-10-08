import { useRef, useState } from "react";
import { LocateFixed, MapPin, Navigation } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { ResponsiveOverlay } from "@/components/ui/responsive-overlay";
import type { GoodfindsState } from "@goodfinds/contracts/state";
import type { Location } from "@goodfinds/contracts/integrations";
import { postalLabel } from "@goodfinds/contracts/integrations";
import { deviceLocation, estimateIP, lookupPostal } from "@/lib/location";
import { openLocationBrowser } from "@/lib/client";
import type { Action } from "@/lib/actions";

const COUNTRY_CODES = [
  "GB",
  "US",
  "CA",
  "AU",
  "NZ",
  "IE",
  "FR",
  "DE",
  "ES",
  "IT",
  "PT",
  "NL",
  "BE",
  "CH",
  "AT",
  "DK",
  "SE",
  "NO",
  "FI",
  "PL",
  "CZ",
  "GR",
  "IN",
  "JP",
  "SG",
  "ZA",
  "BR",
  "MX",
];
const countryNames = new Intl.DisplayNames(["en"], { type: "region" });

function initialCountry(state: GoodfindsState): string {
  if (state.config.location) return state.config.location.country;
  const region = new Intl.Locale(navigator.language).region;
  return region || "GB";
}

export function LocationSettings({
  state,
  busy,
  action,
  browserPage = false,
}: {
  state: GoodfindsState;
  busy: boolean;
  action: Action;
  browserPage?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const changeButton = useRef<HTMLButtonElement>(null);
  const [country, setCountry] = useState(() => initialCountry(state));
  const [customCountry, setCustomCountry] = useState(false);
  const [text, setText] = useState("");
  const [postal, setPostal] = useState(false);
  const [options, setOptions] = useState<Location[]>([]);
  const [working, setWorking] = useState(false);
  const locating = useRef(false);
  const [message, setMessage] = useState("");
  const [browserFallback, setBrowserFallback] = useState(false);
  const saved = state.config.location;
  const area = saved?.display === "postal" ? saved.postal_code : saved?.area;
  const countries = [
    ...new Set([
      initialCountry(state),
      ...(/^[A-Z]{2}$/u.test(country) ? [country] : []),
      ...COUNTRY_CODES,
    ]),
  ].toSorted((a, b) => (countryNames.of(a) ?? a).localeCompare(countryNames.of(b) ?? b));

  async function locate(kind: "device" | "ip" | "manual") {
    if (busy || working || locating.current) return;
    locating.current = true;
    setWorking(true);
    setMessage("");
    setOptions([]);
    setBrowserFallback(false);
    try {
      const found =
        kind === "device"
          ? [await deviceLocation()]
          : kind === "ip"
            ? [await estimateIP()]
            : postal
              ? await lookupPostal(country, text)
              : [
                  {
                    source: "manual" as const,
                    latitude: null,
                    longitude: null,
                    accuracy_m: null,
                    area: text.trim(),
                    country,
                    acquired_at: new Date().toISOString(),
                    display: "town" as const,
                  },
                ];
      if (!found.length || !found[0]?.area) throw new Error("Enter your area and try again.");
      setOptions(found);
      setCountry(found[0].country);
    } catch (error) {
      setMessage(
        error instanceof Error && error.name === "Error"
          ? error.message
          : "Couldn't find your area. Enter it below or try again.",
      );
      setBrowserFallback(kind === "device" && !browserPage);
    } finally {
      locating.current = false;
      setWorking(false);
    }
  }

  async function confirm(location: Location) {
    const next = await action(
      "save_goodfinds_settings",
      { snapshot_revision: state.revision, settings: { location } },
      "Location saved",
    );
    if (next) {
      setOptions([]);
      setCountry(location.country);
      setOpen(false);
    }
  }

  async function openBrowser() {
    setWorking(true);
    setMessage("");
    try {
      await openLocationBrowser(state.mode);
      setMessage("Choose your area in the browser, then return here.");
    } catch {
      setMessage("Couldn't open location. Enter your area below.");
    } finally {
      setWorking(false);
    }
  }

  const editor = (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim() && /^[A-Z]{2}$/u.test(country)) void locate("manual");
      }}
    >
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy || working}
          onClick={() => void locate("device")}
        >
          <LocateFixed className="size-4" aria-hidden="true" />
          Use my location
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy || working}
          onClick={() => void locate("ip")}
        >
          <Navigation className="size-4" aria-hidden="true" />
          Estimate location
        </Button>
      </div>
      <div className="grid gap-4 min-[420px]:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="location-country">Country</Label>
          <NativeSelect
            id="location-country"
            value={customCountry ? "other" : country}
            onChange={(event) => {
              const choice = event.currentTarget.value;
              setCustomCountry(choice === "other");
              if (choice !== "other") setCountry(choice);
              setOptions([]);
            }}
          >
            {countries.map((code) => (
              <NativeSelectOption key={code} value={code}>
                {countryNames.of(code) ?? code}
              </NativeSelectOption>
            ))}
            <NativeSelectOption value="other">Another country</NativeSelectOption>
          </NativeSelect>
          {customCountry && (
            <div className="space-y-2">
              <Label htmlFor="location-country-code">Country code</Label>
              <Input
                id="location-country-code"
                maxLength={2}
                placeholder="e.g. GB"
                value={country}
                onChange={(event) => {
                  setCountry(event.currentTarget.value.toUpperCase());
                  setOptions([]);
                }}
              />
            </div>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="location-format">Location type</Label>
          <NativeSelect
            id="location-format"
            value={postal ? "postal" : "town"}
            onChange={(event) => {
              setPostal(event.currentTarget.value === "postal");
              setOptions([]);
            }}
          >
            <NativeSelectOption value="town">Town or area</NativeSelectOption>
            <NativeSelectOption value="postal">{postalLabel(country)}</NativeSelectOption>
          </NativeSelect>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="location-input">{postal ? postalLabel(country) : "Town or area"}</Label>
        <div className="flex items-center gap-2">
          <Input
            id="location-input"
            maxLength={postal ? 30 : 200}
            value={text}
            onChange={(event) => {
              setText(event.currentTarget.value);
              setOptions([]);
            }}
          />
          <Button
            type="submit"
            disabled={busy || working || !text.trim() || !/^[A-Z]{2}$/u.test(country)}
          >
            Find
          </Button>
        </div>
      </div>
      {working && <output className="block text-sm">Finding your area…</output>}
      {message && <output className="block text-sm">{message}</output>}
      {browserFallback && (
        <Button
          type="button"
          variant="outline"
          disabled={busy || working}
          onClick={() => void openBrowser()}
        >
          Open in browser
        </Button>
      )}
      {options.map((location) => (
        <div
          key={`${location.area}-${location.latitude}-${location.longitude}`}
          className="space-y-3 rounded-lg border p-4"
        >
          <div className="flex items-start gap-2">
            <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-medium">
                {location.area}, {countryNames.of(location.country) ?? location.country}
              </p>
              {location.postal_code && <p className="text-sm">{location.postal_code}</p>}
              {location.source === "ip" && (
                <p className="text-xs text-muted-foreground">Approximate</p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy || working} onClick={() => void confirm(location)}>
              Use this area
            </Button>
            {location.postal_code && (
              <Button
                type="button"
                variant="outline"
                disabled={busy || working}
                onClick={() => void confirm({ ...location, display: "town" })}
              >
                Use town
              </Button>
            )}
          </div>
        </div>
      ))}
    </form>
  );

  if (browserPage)
    return (
      <section className="space-y-5" aria-labelledby="location-heading">
        <div>
          <h3 id="location-heading" className="font-medium">
            Location
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">Choose the area to search from.</p>
        </div>
        {editor}
      </section>
    );

  return (
    <section aria-labelledby="location-heading">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 id="location-heading" className="font-medium">
            Location
          </h3>
          <div className="mt-2 flex items-center gap-2 text-sm">
            <MapPin className="size-4 shrink-0" aria-hidden="true" />
            <span>{area || state.config.origin}</span>
            {saved?.source === "ip" && (
              <span className="text-xs text-muted-foreground">Approximate</span>
            )}
          </div>
        </div>
        <Button
          ref={changeButton}
          type="button"
          variant="outline"
          disabled={busy || working}
          onClick={() => {
            setCountry(initialCountry(state));
            setCustomCountry(false);
            setPostal(saved?.display === "postal");
            setText(area || state.config.origin);
            setMessage("");
            setOptions([]);
            setBrowserFallback(false);
            setOpen(true);
          }}
        >
          Change
        </Button>
      </div>
      <ResponsiveOverlay
        open={open}
        onOpenChange={setOpen}
        title="Change location"
        description="Choose the area to search from."
        returnFocus={changeButton}
      >
        {editor}
      </ResponsiveOverlay>
    </section>
  );
}
