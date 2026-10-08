import type { ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";
import { answerSchema } from "@goodfinds/contracts/search-definition";
import type { Answer, SearchField } from "@goodfinds/contracts/search-definition";

export const NO_PREFERENCE = "__no_preference__";
export const NOT_SURE = "__not_sure__";
export const CUSTOM = "__custom__";

export function nativeQuestion(field: SearchField, custom = false): ElicitRequestFormParams {
  const title = `${field.label}${field.unit ? ` (${field.unit})` : ""}`;
  const properties: ElicitRequestFormParams["requestedSchema"]["properties"] = {};
  const required: string[] = [];
  if (!custom && (field.options || field.type === "boolean" || field.allow_unsure)) {
    if (field.type === "multiple_choice") {
      const choices = (field.options ?? []).map((option) => ({
        const: String(option.value),
        title: option.label,
      }));
      if (field.allow_unsure) choices.push({ const: NOT_SURE, title: "Not sure — help me choose" });
      properties[field.id] = {
        type: "array",
        title,
        items: {
          anyOf: choices,
        },
        minItems: field.required ? 1 : 0,
        maxItems: field.options?.length ?? 30,
      };
      if (field.required) required.push(field.id);
    } else {
      const options =
        field.options ??
        (field.type === "boolean"
          ? [
              { value: true, label: "Yes" },
              { value: false, label: "No" },
            ]
          : []);
      const oneOf = options.map((option) => ({
        const: JSON.stringify(option.value),
        title: option.label,
      }));
      if (["number", "integer"].includes(field.type) || !options.length)
        oneOf.push({ const: CUSTOM, title: "Another value" });
      if (field.allow_unsure) oneOf.push({ const: NOT_SURE, title: "Not sure — help me choose" });
      if (!field.required) oneOf.push({ const: NO_PREFERENCE, title: "No preference" });
      properties[field.id] = { type: "string", title, oneOf };
      required.push(field.id);
    }
  } else if (field.type === "range") {
    const divisor = field.display_divisor ?? 1;
    for (const bound of ["min", "max"] as const) {
      properties[bound] = {
        type: "number",
        title: `${title}: ${bound === "min" ? "minimum" : "maximum"}`,
        ...(field.minimum !== undefined ? { minimum: field.minimum / divisor } : {}),
        ...(field.maximum !== undefined ? { maximum: field.maximum / divisor } : {}),
      };
    }
  } else if (["number", "integer"].includes(field.type)) {
    const divisor = field.display_divisor ?? 1;
    properties[field.id] = {
      type: field.type === "integer" && divisor === 1 ? "integer" : "number",
      title,
      ...(field.minimum !== undefined ? { minimum: field.minimum / divisor } : {}),
      ...(field.maximum !== undefined ? { maximum: field.maximum / divisor } : {}),
    };
    if (field.required || custom) required.push(field.id);
  } else {
    properties[field.id] = {
      type: "string",
      title,
      minLength: field.required ? 1 : 0,
      maxLength: 500,
    };
    if (field.required) required.push(field.id);
  }
  return {
    mode: "form",
    message: `${title}${field.hint ? `. ${field.hint}` : ""}${!field.required && !field.options ? ". Leave blank for no preference." : ""}`,
    requestedSchema: { type: "object", properties, required },
  };
}

export function nativeAnswer(
  field: SearchField,
  content: Record<string, unknown>,
  custom = false,
): Answer {
  if (field.type === "range") {
    const min =
      typeof content["min"] === "number"
        ? content["min"] * (field.display_divisor ?? 1)
        : undefined;
    const max =
      typeof content["max"] === "number"
        ? content["max"] * (field.display_divisor ?? 1)
        : undefined;
    return min === undefined && max === undefined
      ? null
      : { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
  }
  const value = content[field.id];
  if (value === undefined || value === "" || value === NO_PREFERENCE) return null;
  if (!custom && (field.options || field.type === "boolean") && field.type !== "multiple_choice") {
    if (typeof value !== "string") throw new Error("The question returned an invalid choice");
    return answerSchema.parse(JSON.parse(value));
  }
  if (["integer", "number"].includes(field.type) && typeof value === "number") {
    const answer = value * (field.display_divisor ?? 1);
    return field.type === "integer" && field.display_divisor === 100 ? Math.round(answer) : answer;
  }
  return answerSchema.parse(value);
}
