import { z } from "zod";

export const verificationDefinitionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    label: z.string().trim().min(1).max(200),
    question: z.string().trim().min(1).max(500),
  })
  .strict();
export const verificationCheckSchema = verificationDefinitionSchema
  .extend({
    state: z.enum(["confirmed", "missing", "unknown", "conflicting"]),
    evidence: z.string().trim().min(1).max(2000).nullable(),
  })
  .refine(
    (check) => !["confirmed", "missing"].includes(check.state) || check.evidence !== null,
    "Confirmed or missing details need evidence",
  );
export const setupCostSchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    price_minor: z.number().int().nonnegative().nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    basis: z.enum(["observed", "estimate", "unknown"]),
    evidence: z.string().trim().min(1).max(2000).nullable(),
  })
  .strict()
  .refine(
    (cost) =>
      cost.basis === "unknown"
        ? cost.price_minor === null
        : cost.price_minor !== null && cost.evidence !== null,
    "Known additional costs need an amount and supporting source",
  );
export type VerificationCheck = z.infer<typeof verificationCheckSchema>;
export type VerificationDefinition = z.infer<typeof verificationDefinitionSchema>;
type EvidenceListing = {
  verification_checks?: VerificationCheck[] | undefined;
  attributes?: Record<string, unknown> | null | undefined;
  evidence?: Record<string, unknown> | null | undefined;
  condition?: string | null | undefined;
  functional?: boolean | null | undefined;
  product?: string | undefined;
};
function accessoryEvidence(listing: EvidenceListing, id: string): string | null {
  const names: Record<string, string[]> = {
    portafilter: ["portafilter", "portafilter handle"],
    filter_baskets: ["filter baskets", "filter basket", "baskets", "basket"],
    tamper: ["tamper", "integrated tamper"],
  };
  for (const field of ["accessories", "package_contents"]) {
    const contents = listing.attributes?.[field];
    const source = listing.evidence?.[field];
    if (typeof source !== "string" || !source.trim()) continue;
    const items = Array.isArray(contents)
      ? contents
      : typeof contents === "string"
        ? contents.split(/[;,]/u)
        : [];
    if (
      items.some(
        (item: unknown) =>
          typeof item === "string" &&
          (names[id] ?? [id.replaceAll("_", " ")]).includes(
            item
              .trim()
              .toLowerCase()
              .replaceAll("_", " ")
              .replace(/^(?:[1-9]\d*|one|two|three|four|five|six|seven|eight|nine|ten)\s+/u, ""),
          ),
      )
    )
      return source;
  }
  return null;
}

// A gallery not showing a part is unknown. Only positive evidence establishes absence.
export function verificationChecks(
  listing: EvidenceListing,
  expected: VerificationDefinition[] = [],
): VerificationCheck[] {
  const checks = new Map((listing.verification_checks ?? []).map((check) => [check.id, check]));
  // New sourced inclusion evidence resolves unknowns, while explicit conflicts stay unresolved.
  for (const [id, check] of checks) {
    const accessory = accessoryEvidence(listing, id);
    if (check.state === "unknown" && accessory)
      checks.set(id, { ...check, state: "confirmed", evidence: accessory });
  }
  for (const definition of expected) {
    if (checks.has(definition.id)) continue;
    const accessory = accessoryEvidence(listing, definition.id);
    const value = listing.attributes?.[definition.id] ?? (accessory ? true : undefined);
    const evidence = listing.evidence?.[definition.id] ?? accessory;
    checks.set(definition.id, {
      ...definition,
      state:
        typeof evidence === "string" && evidence.trim() && typeof value === "boolean"
          ? value
            ? "confirmed"
            : "missing"
          : "unknown",
      evidence: typeof evidence === "string" && evidence.trim() ? evidence : null,
    });
  }
  if (!checks.has("condition") && (!listing.condition || listing.condition === "unknown"))
    checks.set("condition", {
      id: "condition",
      label: "Condition",
      question: "Could you confirm its condition and whether there is any damage?",
      state: "unknown",
      evidence: null,
    });
  if (!checks.has("functional") && listing.functional == null)
    checks.set("functional", {
      id: "functional",
      label: "Working condition",
      question: "Is everything working properly, with no faults?",
      state: "unknown",
      evidence: null,
    });
  if (!expected.length && listing.product === "espresso_machine") {
    for (const [id, label, question] of [
      ["portafilter", "Portafilter", "Does it include the portafilter?"],
      ["filter_baskets", "Filter baskets", "Which filter baskets are included?"],
      ["tamper", "Tamper", "Is the tamper included?"],
    ]) {
      if (!id || !label || !question || checks.has(id)) continue;
      const accessory = accessoryEvidence(listing, id);
      const evidence = listing.evidence?.[id] ?? accessory;
      const value = listing.attributes?.[id] ?? (accessory ? true : undefined);
      checks.set(id, {
        id,
        label,
        question,
        state:
          typeof value === "boolean" && typeof evidence === "string" && evidence.trim()
            ? value
              ? "confirmed"
              : "missing"
            : "unknown",
        evidence: typeof evidence === "string" && evidence.trim() ? evidence : null,
      });
    }
  }
  if (
    !checks.has("package_contents") &&
    !expected.length &&
    listing.product !== "espresso_machine" &&
    listing.product !== "rental" &&
    !listing.attributes?.["package_contents"]
  )
    checks.set("package_contents", {
      id: "package_contents",
      label: "Included accessories",
      question: "Could you confirm which parts and accessories are included?",
      state: "unknown",
      evidence: null,
    });
  return [...checks.values()];
}
export function unresolvedQuestions(checks: VerificationCheck[]): string[] {
  return [
    ...new Set(
      checks.filter((check) => check.state !== "confirmed").map((check) => check.question),
    ),
  ];
}

// Inspection is broader than first contact. Generate short, useful enquiries from
// unresolved facts rather than copying research/checklist wording to the seller.
export function openingQuestions(checks: VerificationCheck[]): string[] {
  const unresolved = checks.filter((check) => ["unknown", "conflicting"].includes(check.state));
  const questions: string[] = [];
  if (
    unresolved.some((check) =>
      /^(?:functional|functionality|working(?:_condition)?)$/u.test(check.id),
    )
  )
    questions.push("Does it all work okay?");
  else if (unresolved.some((check) => check.id === "condition"))
    questions.push("Is it in good condition?");

  const parts: Record<string, string> = {
    portafilter: "the portafilter",
    filter_baskets: "the baskets",
    tamper: "the tamper",
    water_tank: "the water tank",
    charger: "the charger",
    power_cable: "the power cable",
    remote: "the remote",
  };
  const contents = unresolved.filter(
    (check) =>
      Object.hasOwn(parts, check.id) ||
      /(?:^|[ _])(?:accessories|package_contents|included_parts|completeness|complete)(?:$|[ _])/iu.test(
        `${check.id} ${check.label}`,
      ),
  );
  if (contents.length)
    questions.push(
      contents.length === 1 && parts[contents[0]?.id ?? ""]
        ? `Does it include ${parts[contents[0]?.id ?? ""]}?`
        : "Are all the parts and accessories included?",
    );
  return questions;
}
export function setupCostTotal(listing: {
  price_minor: number | null;
  total_cash_cost_minor?: number | null | undefined;
  currency?: string | null | undefined;
  setup_costs?: z.infer<typeof setupCostSchema>[] | undefined;
  costs_complete?: boolean | null | undefined;
}) {
  const base = listing.total_cash_cost_minor ?? listing.price_minor;
  const costs = listing.setup_costs ?? [];
  if (
    base === null ||
    (costs.length > 0 && (listing.costs_complete === false || listing.costs_complete === null)) ||
    costs.some((cost) => cost.price_minor === null || cost.currency !== (listing.currency ?? "GBP"))
  )
    return { total_minor: null, basis: "unknown" as const };
  return {
    total_minor: base + costs.reduce((sum, cost) => sum + (cost.price_minor ?? 0), 0),
    basis: costs.some((cost) => cost.basis === "estimate")
      ? ("estimate" as const)
      : ("observed" as const),
  };
}
