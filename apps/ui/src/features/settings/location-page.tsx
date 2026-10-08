import { useEffect, useState } from "react";
import { invoke } from "@/lib/client";
import { errorMessage } from "@goodfinds/contracts/state";
import type { GoodfindsState } from "@goodfinds/contracts/state";
import type { Action } from "@/lib/actions";
import { LocationSettings } from "@/features/settings/location-settings";

export function LocationPage() {
  const [state, setState] = useState<GoodfindsState>(),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  const mode = window.__GOODFINDS_PREVIEW__?.workspaceMode ?? "live";
  useEffect(() => {
    let cancelled = false;
    void invoke("get_goodfinds_workspace", { mode })
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) setMessage(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [mode]);
  const action: Action = async (name, args) => {
    setBusy(true);
    setMessage("");
    try {
      const next = await invoke(name, { ...args, mode });
      setState(next);
      setDone(true);
      return next;
    } catch (error) {
      setMessage(errorMessage(error));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="mx-auto max-w-xl space-y-5 p-6">
      <h1 className="text-2xl font-semibold">Choose your Goodfinds location</h1>
      {done ? (
        <output className="block">
          Location saved. Return to Goodfinds and refresh Settings. You can close this page.
        </output>
      ) : state ? (
        <LocationSettings state={state} busy={busy} action={action} browserPage />
      ) : (
        <p>Opening your location settings…</p>
      )}
      {message && <p role="alert">{message}</p>}
    </main>
  );
}
