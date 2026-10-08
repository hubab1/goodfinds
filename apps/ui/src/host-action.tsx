import { MenuItem } from "@/components/ui/menu";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ReactNode } from "react";
import { LoaderCircle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requestHostAction } from "@/lib/client";
import { errorMessage } from "@goodfinds/contracts/state";
import { hostRequest } from "@goodfinds/contracts/host-request";

const defaultIcon = <Sparkles aria-hidden="true" />;

function useHostAction(request: string, disabled: boolean, autoStart = false) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const started = useRef(false);
  const running = useRef(false);
  const prompt = hostRequest(request);
  async function run() {
    if (running.current || disabled) return;
    running.current = true;
    setBusy(true);
    try {
      await requestHostAction(prompt);
      setMessage("Started.");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
      running.current = false;
    }
  }
  const start = useEffectEvent(() => {
    void run();
  });
  useEffect(() => {
    if (autoStart && !disabled && !started.current) {
      started.current = true;
      start();
    }
  }, [autoStart, disabled]);
  return { busy, message, run };
}

export function HostAction({
  request,
  children,
  disabled = false,
  icon = defaultIcon,
  autoStart = false,
  className,
}: {
  request: string;
  children: string;
  disabled?: boolean;
  icon?: ReactNode;
  autoStart?: boolean;
  className?: string;
}) {
  const { busy, message, run } = useHostAction(request, disabled, autoStart);
  return (
    <div className="space-y-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={className}
        disabled={busy || disabled}
        onClick={() => {
          void run();
        }}
      >
        {busy ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : icon}
        {busy ? "Starting…" : children}
      </Button>
      {message && <output className="block text-xs">{message}</output>}
    </div>
  );
}

export function HostMenuAction({
  request,
  children,
  disabled = false,
  icon = defaultIcon,
  className,
}: {
  request: string;
  children: string;
  disabled?: boolean;
  icon?: ReactNode;
  className?: string;
}) {
  const { busy, message, run } = useHostAction(request, disabled);
  return (
    <>
      <MenuItem
        className={className}
        disabled={busy || disabled}
        closeOnClick={false}
        onClick={() => {
          void run();
        }}
      >
        {busy ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : icon}
        {busy ? "Starting…" : children}
      </MenuItem>
      {message && (
        <output className="block px-3 py-2 text-xs" aria-live="polite">
          {message}
        </output>
      )}
    </>
  );
}
