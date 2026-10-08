const formatter = new Intl.RelativeTimeFormat("en", { numeric: "always" });
const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 60 * 60_000],
  ["month", 30 * 24 * 60 * 60_000],
  ["day", 24 * 60 * 60_000],
  ["hour", 60 * 60_000],
  ["minute", 60_000],
];

export function relativeTime(value: string | null | undefined, now: number): string {
  if (!value) return "Not checked yet";
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "Unknown date";
  const difference = at - now;
  if (Math.abs(difference) < 60_000) return difference > 0 ? "in a moment" : "just now";
  const [unit, size] = units.find(([, duration]) => Math.abs(difference) >= duration) ?? [
    "minute",
    60_000,
  ];
  return formatter.format(Math.sign(difference) * Math.floor(Math.abs(difference) / size), unit);
}

export function exactTime(value: string): string {
  return new Date(value).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
