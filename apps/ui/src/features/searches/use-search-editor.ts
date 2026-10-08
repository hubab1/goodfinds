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
  search: SavedSearch | undefined;
  draft?: SearchDraft;
  revision: string;
  busy: boolean;
  action: Action;
  close: () => void;
};
export function useSearchEditor({
  search,
  draft,
  revision,
  busy,
  action,
  close,
}: SearchEditorOptions) {
  const initial = search?.definition ?? draft?.definition ?? SEARCH_TEMPLATES[0];
  if (!initial) throw new Error("No search definitions are available");
  const [definition, setDefinition] = useState<SearchDefinition>(() =>
    withSellerListingField(initial),
  );
  const [answers, setAnswers] = useState<Answers>(() => search?.values ?? draft?.values ?? {});
  const [marketplaces, setMarketplaces] = useState<Marketplace[]>(
    () => search?.marketplaces ?? draft?.marketplaces ?? ["facebook_marketplace"],
  );
  const [discovery, setDiscovery] = useState(() => search?.discovery ?? draft?.discovery);
  const [name, setName] = useState(search?.name ?? draft?.name ?? "");
  const [phase, setPhase] = useState<"edit" | "review" | "remove">("edit");
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
    const parsed = searchInputSchema.safeParse({
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
      await requestSearchInterview(brief.trim());
      if (!dismissed.current) dismiss();
    } catch (failure) {
      setValidation(errorMessage(failure));
    } finally {
      submitting.current = false;
      setSending(false);
    }
  }
  async function remove(): Promise<void> {
    if (search)
      await commit(
        "remove_goodfinds_search",
        { search_id: search.id, snapshot_revision: revision },
        "Search removed",
      );
  }

  function chooseCategory(category: string) {
    const next = SEARCH_TEMPLATES.find((item) => item.category === category);
    if (next) {
      setDefinition(withSellerListingField(next));
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
    remove,
    chooseCategory,
    changeScope,
    changeReferenceModel,
  };
}
