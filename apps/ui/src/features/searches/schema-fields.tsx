import { FormField } from "@/components/ui/form-field";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { answerError, isVisible } from "@goodfinds/contracts/search-definition";
import type {
  Answer,
  Answers,
  SearchDefinition,
  SearchField,
} from "@goodfinds/contracts/search-definition";

function NumericInput({
  field,
  value,
  change,
  id,
  invalid,
  label,
}: {
  field: SearchField;
  value: number | undefined;
  change: (value: Answer) => void;
  id: string;
  invalid: boolean;
  label?: string;
}) {
  const divisor = field.display_divisor ?? 1;
  return (
    <Input
      id={id}
      type="number"
      aria-label={label}
      aria-invalid={invalid}
      min={field.minimum !== undefined ? field.minimum / divisor : undefined}
      max={field.maximum !== undefined ? field.maximum / divisor : undefined}
      step={
        field.type === "integer" || field.match?.attribute === "seller_listing_count"
          ? 1 / divisor
          : "any"
      }
      value={value === undefined ? "" : value / divisor}
      list={field.options ? `${id}-options` : undefined}
      onChange={(event) => {
        const input = event.currentTarget.value;
        const number = Number(input) * divisor;
        change(
          input === ""
            ? null
            : field.type === "integer" && divisor === 100
              ? Math.round(number)
              : number,
        );
      }}
    />
  );
}

function FieldControl({
  field,
  answer,
  change,
  invalid,
}: {
  field: SearchField;
  answer: Answer | undefined;
  change: (value: Answer) => void;
  invalid: boolean;
}) {
  const id = `search-field-${field.id}`;
  switch (field.type) {
    case "text":
    case "location":
      return (
        <Input
          id={id}
          value={typeof answer === "string" ? answer : ""}
          maxLength={500}
          aria-invalid={invalid}
          onChange={(event) => change(event.currentTarget.value || null)}
        />
      );
    case "integer":
    case "number":
      return (
        <>
          <NumericInput
            field={field}
            id={id}
            value={typeof answer === "number" ? answer : undefined}
            change={change}
            invalid={invalid}
          />
          {field.options && (
            <datalist id={`${id}-options`}>
              {field.options.map((option) => (
                <option
                  key={String(option.value)}
                  value={Number(option.value) / (field.display_divisor ?? 1)}
                >
                  {option.label}
                </option>
              ))}
            </datalist>
          )}
        </>
      );
    case "boolean":
    case "single_choice": {
      const options = field.options ?? [
        { value: true, label: "Yes" },
        { value: false, label: "No" },
      ];
      return (
        <NativeSelect
          id={id}
          value={answer == null ? "" : JSON.stringify(answer)}
          aria-invalid={invalid}
          onChange={(event) => {
            const selected = options.find(
              (option) => JSON.stringify(option.value) === event.currentTarget.value,
            );
            change(selected?.value ?? null);
          }}
        >
          <NativeSelectOption value="">
            {field.required ? "Choose an option" : "No preference"}
          </NativeSelectOption>
          {options.map((option) => (
            <NativeSelectOption
              key={JSON.stringify(option.value)}
              value={JSON.stringify(option.value)}
            >
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      );
    }
    case "multiple_choice": {
      const selected = Array.isArray(answer) ? answer : [];
      return (
        <fieldset className="flex flex-wrap gap-2" aria-label={field.label} aria-invalid={invalid}>
          {(field.options ?? []).map((option, index) => (
            <label
              key={String(option.value)}
              htmlFor={`${id}-${index}`}
              className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-secondary"
            >
              <Checkbox
                id={`${id}-${index}`}
                checked={selected.includes(String(option.value))}
                onChange={(event) =>
                  change(
                    event.currentTarget.checked
                      ? [...selected, String(option.value)]
                      : selected.filter((value) => value !== option.value),
                  )
                }
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      );
    }
    case "range": {
      const range =
        typeof answer === "object" && answer !== null && !Array.isArray(answer) ? answer : {};
      return (
        <div className="grid grid-cols-2 gap-2">
          {(["min", "max"] as const).map((bound) => (
            <div key={bound} className="space-y-1">
              <Label htmlFor={`${id}-${bound}`} className="text-xs text-muted-foreground">
                {bound === "min" ? "Minimum" : "Maximum"}
              </Label>
              <NumericInput
                field={field}
                id={`${id}-${bound}`}
                label={`${field.label}: ${bound}`}
                value={range[bound]}
                invalid={invalid}
                change={(value) => {
                  const next = { ...range };
                  if (typeof value === "number") next[bound] = value;
                  else delete next[bound];
                  change(Object.keys(next).length ? next : null);
                }}
              />
            </div>
          ))}
        </div>
      );
    }
  }
  return null;
}

export function SchemaFields({
  definition,
  answers,
  change,
  showErrors = false,
}: {
  definition: SearchDefinition;
  answers: Answers;
  change: (id: string, value: Answer) => void;
  showErrors?: boolean;
}) {
  return (
    <>
      {definition.fields
        .filter((field) => isVisible(field, answers, definition))
        .map((field) => {
          const error = showErrors ? answerError(field, answers[field.id]) : undefined;
          return (
            <FormField
              key={field.id}
              id={`search-field-${field.id}`}
              label={`${field.label}${field.unit ? ` (${field.unit})` : ""}`}
              group={field.type === "multiple_choice" || field.type === "range"}
              full={["location", "text", "multiple_choice"].includes(field.type)}
              hint={`${field.hint ?? (field.required ? "Required" : "Optional · leave blank for no preference")}${field.match?.importance === "preferred" ? " · preference" : ""}`}
              error={error}
            >
              <FieldControl
                field={field}
                answer={answers[field.id]}
                change={(value) => change(field.id, value)}
                invalid={Boolean(error)}
              />
            </FormField>
          );
        })}
    </>
  );
}
