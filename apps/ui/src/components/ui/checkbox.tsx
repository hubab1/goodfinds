import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { useFieldControl } from "./form-field";
import "./controls.css";

export function Checkbox({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  const field = useFieldControl(props);
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      className={cn(
        "size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50",
        className,
      )}
      {...props}
      {...field}
    />
  );
}

export function Switch({
  className,
  ...props
}: Omit<ComponentProps<"input">, "type" | "role" | "defaultChecked"> & { checked: boolean }) {
  const field = useFieldControl(props);
  return (
    <input
      type="checkbox"
      role="switch"
      aria-checked={props.checked}
      data-slot="switch"
      className={cn("ui-switch", className)}
      {...props}
      {...field}
    />
  );
}
