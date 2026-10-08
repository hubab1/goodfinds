import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { useFieldControl } from "./form-field";
import "./controls.css";

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  const field = useFieldControl(props);
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "w-full min-h-24 resize-y rounded-lg border border-input bg-background p-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        className,
      )}
      {...props}
      {...field}
    />
  );
}
