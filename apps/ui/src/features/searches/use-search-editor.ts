import { MARKETPLACES, marketHome } from "@goodfinds/contracts/integrations";
import {
  resolveRegion,
  localizeTemplate,
  browserLocaleHints,
  type RegionalConfig,
} from "@goodfinds/contracts/regional";
import type { Marketplace } from "@goodfinds/contracts/integrations";
import type { Action, PanelInput, PanelTool } from "@/lib/actions";
import { useEffect, useId, useRef, useState } from "react";
import { errorMessage } from "@goodfinds/contracts/state";
import { requestSearchInterview } from "@/lib/client";
import { withSellerListingField } from "@/lib/seller";
import {
  SEARCH_TEMPLATES,
  activeAnswers,
  searchInputSchema,
  validateAnswers,
} from "@goodfinds/contracts/search-definition";
import type {
  Answers,
  SearchDefinition,
  SearchDraft,
} from "@goodfinds/contracts/search-definition";
import type { SavedSearch } from "@goodfinds/contracts/state";

export type SearchEditorOptions = {
  config?: RegionalConfig;
  search: SavedSearch | undefined;
  draft?: SearchDraft;
  revision: string;
  busy: boolean;
  action: Action;
  close: () => void;
};
export function useSearchEditor({
  config = {},
  search,
  draft,
  revision,
  busy,
  action,
  close,
}: SearchEditorOptions) {
  const initial = search?.definition ?? draft?.definition ?? SEARCH_TEMPLATES[0];
  if (!initial) throw new Error("No search definitions are available");
  const region = resolveRegion(config, {}, browserLocaleHints(), initial.category);
  const original = search ?? draft;
  const manualCurrency = useRef(
    Boolean(original?.definition.price.currency || config.regional_preferences?.currency),
  );
  const [currency, setCurrency] = useState(
    () => original?.definition.price.currency ?? region.currency ?? "",
  );
  const [market, setMarket] = useState(
    () =>
      original?.market ?? {
        ...(region.country ? { country: region.country } : {}),
        ...(region.locale ? { locale: region.locale } : {}),
        fulfilment: region.fulfilment,
      },
  );
  const [definition, setDefinition] = useState<SearchDefinition>(() =>
    withSellerListingField(
      !original && region.currency ? localizeTemplate(initial, region.currency) : initial,
    ),
  );
  const [answers, setAnswers] = useState<Answers>(() => search?.values ?? draft?.values ?? {});
  const manualMarketplaces = useRef(Boolean(original));
  const [marketplaces, updateMarketplaces] = useState<Marketplace[]>(() =>
    original
      ? (original.marketplaces ?? ["facebook_marketplace"])
      : region.marketplaces.map((m) => m.id),
  );
  function setMarketplaces(update: Marketplace[] | ((current: Marketplace[]) => Marketplace[])) {
    manualMarketplaces.current = true;
    updateMarketplaces(update);
  }
  const availableMarketplaces = MARKETPLACES.filter(
    (platform) =>
      marketplaces.includes(platform.id) ||
      marketHome(platform.id, market.country, market.locale ?? region.locale),
  );
  function changeMarket(next: typeof market) {
    setMarket(next);
    if (next.country !== market.country && !manualCurrency.current) {
      const nextCurrency = resolveRegion(config, next, browserLocaleHints()).currency;
      if (nextCurrency) applyCurrency(nextCurrency);
    }
    if (!manualMarketplaces.current)
      updateMarketplaces(
        resolveRegion(config, next, {}, definition.category).marketplaces.map((m) => m.id),
      );
  }
  function changeCurrency(next: string) {
    manualCurrency.current = true;
    applyCurrency(next);
  }
  function applyCurrency(next: string) {
    if (!next || next === currency) return;
    setCurrency(next);
    setDefinition((current) => ({
      ...localizeTemplate(current, next),
      version: current.version + 1,
    }));
    // Changing currency is not an exchange-rate conversion. Ask for the budget again.
    setAnswers((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([id]) => definition.fields.find((f) => f.id === id)?.match?.attribute !== "price_minor",
        ),
      ),
    );
  }
  const [discovery, setDiscovery] = useState(() => search?.discovery ?? draft?.discovery);
  const [name, setName] = useState(search?.name ?? draft?.name ?? "");
  const [phase, setPhase] = useState<"edit" | "review">("edit");
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (phase !== "edit") title.current?.focus();
  }, [phase]);
  const [validation, setValidation] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [brief, setBrief] = useState("");
  const [sending, setSending] = useState(false);
  const interviewFormId = useId();
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const dismissed = useRef(false);
  const disabled = busy || sending || saving;
  function dismiss() {
    dismissed.current = true;
    close();
  }
  async function commit<K extends PanelTool>(command: K, args: PanelInput<K>, message: string) {
    if (disabled || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    try {
      if ((await action(command, args, message)) && !dismissed.current) dismiss();
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }
  const values = activeAnswers(definition, answers);
  async function save(): Promise<void> {
    if (disabled || submitting.current) return;
    if (!currency || (!original && !market.country)) {
      setValidation("Choose a shopping country and budget currency.");
      return;
    }
    const parsed = searchInputSchema.safeParse({
      market,
      ...(search ? { id: search.id, ...(search.cover ? { cover: search.cover } : {}) } : {}),
      marketplaces,
      ...(discovery ? { discovery } : {}),
      name,
      product: definition.category,
      enabled: search?.enabled ?? true,
      definition,
      values,
    });
    if (!parsed.success) {
      setShowErrors(true);
      setValidation(parsed.error.issues[0]?.message ?? "Check your search details");
      return;
    }
    setValidation("");
    if (phase !== "review") {
      setPhase("review");
      return;
    }
    await commit(
      "save_goodfinds_search",
      {
        search: parsed.data,
        snapshot_revision: revision,
        ...(draft ? { draft_id: draft.id } : {}),
      },
      "Search saved",
    );
  }
  async function saveDraft(): Promise<void> {
    if (!currency) {
      setValidation("Choose a budget currency.");
      return;
    }
    const partialValues = Object.fromEntries(
      Object.entries(values).filter(
        ([id, value]) =>
          value !== null || !definition.fields.find((field) => field.id === id)?.required,
      ),
    );
    const errors = validateAnswers(definition, partialValues, true);
    if (!name.trim() || errors.length) {
      setValidation(errors[0] ?? "Give your search a name");
      return;
    }
    await commit(
      "save_goodfinds_search_draft",
      {
        snapshot_revision: revision,
        draft: {
          ...(draft ? { id: draft.id } : {}),
          name,
          market,
          definition,
          values: partialValues,
          ...(draft?.uncertain_fields
            ? {
                uncertain_fields: draft.uncertain_fields.filter(
                  (id) =>
                    partialValues[id] === undefined &&
                    definition.fields.some((field) => field.id === id),
                ),
              }
            : {}),
          marketplaces,
          ...(discovery ? { discovery } : {}),
        },
      },
      "Unfinished search saved",
    );
  }
  async function interview(): Promise<void> {
    if (disabled || submitting.current) return;
    if (!brief.trim()) {
      setValidation("Describe what you are looking for");
      return;
    }
    submitting.current = true;
    setSending(true);
    setValidation("");
    try {
      await requestSearchInterview(
        `${brief.trim()}\nCurrent shopping choices: ${JSON.stringify({ ...market, ...(currency ? { currency } : {}), ...(manualMarketplaces.current ? { marketplaces } : {}) })}. Preserve these choices unless my brief explicitly changes them.`,
      );
      if (!dismissed.current) dismiss();
    } catch (failure) {
      setValidation(errorMessage(failure));
    } finally {
      submitting.current = false;
      setSending(false);
    }
  }
  function chooseCategory(category: string) {
    const next = SEARCH_TEMPLATES.find((item) => item.category === category);
    if (next) {
      setDefinition(withSellerListingField(currency ? localizeTemplate(next, currency) : next));
      if (!manualMarketplaces.current)
        updateMarketplaces(
          resolveRegion(config, market, {}, category).marketplaces.map((m) => m.id),
        );
      setAnswers({});
      setShowErrors(false);
      setValidation("");
    }
  }
  function changeScope(scope: string) {
    if (scope === "exact" || scope === "alternatives" || scope === "help_choose") {
      setDiscovery((current) => ({
        ...current,
        model_attribute: current?.model_attribute ?? "model",
        scope,
      }));
      const modelAttribute = discovery?.model_attribute ?? "model";
      setDefinition((current) => {
        if (
          !current.fields.some(
            (field) =>
              field.match?.attribute === modelAttribute && field.match.importance !== "preferred",
          )
        )
          return current;
        return {
          ...current,
          version: current.version + 1,
          fields: current.fields.map((field) =>
            field.match?.attribute === modelAttribute
              ? {
                  ...field,
                  match: { ...field.match, importance: "preferred" },
                }
              : field,
          ),
        };
      });
    }
  }
  function changeReferenceModel(model: string) {
    setDiscovery((current) => {
      const next = {
        ...current,
        scope: current?.scope ?? "alternatives",
        model_attribute: current?.model_attribute ?? "model",
      };
      if (model.trim()) return { ...next, reference_model: model };
      const { reference_model: removed, ...rest } = next;
      void removed;
      return rest;
    });
  }
  return {
    definition,
    market,
    currency,
    changeMarket,
    changeCurrency,
    availableMarketplaces,
    answers,
    setAnswers,
    marketplaces,
    setMarketplaces,
    discovery,
    name,
    setName,
    phase,
    setPhase,
    title,
    validation,
    showErrors,
    brief,
    setBrief,
    sending,
    interviewFormId,
    saving,
    disabled,
    dismiss,
    values,
    save,
    saveDraft,
    interview,
    chooseCategory,
    changeScope,
    changeReferenceModel,
  };
}
