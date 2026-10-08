import { useSyncExternalStore } from "react";
import { exactTime, relativeTime } from "@/lib/relative-time";

let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
function tick() {
  now = Date.now();
  for (const notify of listeners) notify();
}
function subscribe(notify: () => void) {
  listeners.add(notify);
  if (!timer) {
    tick();
    timer = setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", tick);
  }
  return () => {
    listeners.delete(notify);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
      document.removeEventListener("visibilitychange", tick);
    }
  };
}
const snapshot = () => now;

export function RelativeTime({
  value,
  empty = "Not checked yet",
  className,
}: {
  value: string | null | undefined;
  empty?: string;
  className?: string;
}) {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!value) return <span className={className}>{empty}</span>;
  if (!Number.isFinite(Date.parse(value))) return <span className={className}>Unknown date</span>;
  return (
    <time dateTime={value} title={exactTime(value)} className={className}>
      {relativeTime(value, current)}
    </time>
  );
}
