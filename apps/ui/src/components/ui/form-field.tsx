import { createContext, useContext, useId, useMemo } from "react";
import type { AriaAttributes, ReactNode } from "react";
import { Label } from "./label";
import { cn } from "@/lib/utils";

type FieldControlProps = {
  id?: string | undefined;
  "aria-describedby"?: string | undefined;
  "aria-invalid"?: AriaAttributes["aria-invalid"];
};

const FieldContext = createContext<FieldControlProps>({});

/** Controls inherit the field's label, help and error associations. */
export function useFieldControl(props: FieldControlProps): FieldControlProps {
  const field = useContext(FieldContext);
  return {
    id: props.id ?? field.id,
    "aria-describedby":
      [field["aria-describedby"], props["aria-describedby"]].filter(Boolean).join(" ") || undefined,
    "aria-invalid": props["aria-invalid"] ?? field["aria-invalid"],
  };
}

export function FormField({
  id,
  label,
  hint,
  error,
  full = false,
  group = false,
  className,
  children,
}: {
  id?: string | undefined;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
  full?: boolean;
  group?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const description =
    [hint ? `${fieldId}-hint` : "", error ? `${fieldId}-error` : ""].filter(Boolean).join(" ") ||
    undefined;
  const invalid = Boolean(error);
  const context = useMemo(
    () => ({
      id: group ? undefined : fieldId,
      "aria-describedby": description,
      "aria-invalid": invalid,
    }),
    [group, fieldId, description, invalid],
  );
  const content = (
    <>
      {group ? (
        <legend className="mb-2 text-sm font-medium">{label}</legend>
      ) : (
        <Label htmlFor={fieldId}>{label}</Label>
      )}
      {children}
      {hint && (
        <p id={`${fieldId}-hint`} className="text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${fieldId}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  );
  const classes = cn("min-w-0 space-y-2", full && "col-span-full", className);
  return (
    <FieldContext value={context}>
      {group ? (
        <fieldset className={classes} aria-describedby={description} aria-invalid={Boolean(error)}>
          {content}
        </fieldset>
      ) : (
        <div className={classes}>{content}</div>
      )}
    </FieldContext>
  );
}
