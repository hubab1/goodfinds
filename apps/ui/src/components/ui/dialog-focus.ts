// Touch opens the sheet without summoning the keyboard. Read-only dialogs focus
// their container so opening one never primes an unrelated action button.
export function dialogInitialFocus(
  popup: HTMLElement | null,
  interaction: string,
): HTMLElement | null {
  if (!popup || interaction === "touch") return popup;
  const fields = popup.querySelectorAll<HTMLElement>(
    "input:not([type=hidden]):not([readonly]), textarea:not([readonly]), select",
  );
  return (
    [...fields].find(
      (field) =>
        !field.matches(":disabled") && !field.closest("[hidden], [inert], details:not([open])"),
    ) ?? popup
  );
}
