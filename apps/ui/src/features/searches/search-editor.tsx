import { Checkbox } from "@/components/ui/checkbox";
import type { Action } from "@/lib/actions";
import { FormField as Field } from "@/components/ui/form-field";
import { Disclosure } from "@/components/ui/disclosure";
import { MARKETPLACES } from "@goodfinds/contracts/integrations";
import { MarketplaceLogo } from "@/marketplace-logo";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { SEARCH_TEMPLATES, formatAnswer, isVisible } from "@goodfinds/contracts/search-definition";
import type { SearchDraft } from "@goodfinds/contracts/search-definition";
import { SchemaFields } from "@/features/searches/schema-fields";
import type { SavedSearch } from "@goodfinds/contracts/state";
import { useSearchEditor } from "./use-search-editor";

export function SearchEditor({
  search,
  draft,
  revision,
  busy,
  error,
  removable,
  action,
  close,
}: {
  search: SavedSearch | undefined;
  draft?: SearchDraft;
  revision: string;
  busy: boolean;
  error: string;
  removable: boolean;
  action: Action;
  close: () => void;
}) {
  const {
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
  } = useSearchEditor({ search, ...(draft ? { draft } : {}), revision, busy, action, close });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle ref={title} tabIndex={-1}>
            {phase === "remove"
              ? `Remove ${name}?`
              : phase === "review"
                ? "Review your search"
                : search
                  ? "Edit search"
                  : draft
                    ? "Finish your search"
                    : "New search"}
          </DialogTitle>
          <DialogDescription>
            {phase === "remove"
              ? "Your saved listings and their history will be kept."
              : phase === "review"
                ? "Check the details, then save."
                : !search && !draft
                  ? "Tell us what you want, or add the details below."
                  : definition.description}
          </DialogDescription>
        </DialogHeader>
        <form
          id={interviewFormId}
          onSubmit={(event) => {
            event.preventDefault();
            void interview();
          }}
        />
        {phase === "remove" ? (
          <form
            className="dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              void remove();
            }}
          >
            {(validation || error) && (
              <DialogBody>
                <FormError message={validation || error} />
              </DialogBody>
            )}
            <DialogFooter>
              <Button variant="outline" disabled={disabled} onClick={() => setPhase("edit")}>
                Go back
              </Button>
              <Button type="submit" disabled={disabled}>
                {saving ? "Removing…" : "Remove search"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            className="dialog-form"
          >
            <DialogBody className="space-y-5">
              {phase === "edit" ? (
                <>
                  {!search && !draft && (
                    <div className="space-y-3 rounded-lg border bg-secondary/30 p-4">
                      <Label htmlFor="search-brief">Describe what you are looking for</Label>
                      <Input
                        id="search-brief"
                        form={interviewFormId}
                        placeholder="e.g. A two-bedroom flat near Birmingham"
                        maxLength={2000}
                        value={brief}
                        disabled={disabled}
                        onChange={(event) => setBrief(event.currentTarget.value)}
                      />
                      <Button type="submit" form={interviewFormId} disabled={disabled}>
                        {sending ? "Opening questions…" : "Ask me questions"}
                      </Button>
                      <p className="text-xs text-muted-foreground">Or fill in the details below.</p>
                    </div>
                  )}
                  <fieldset disabled={disabled} className="grid gap-4 min-[420px]:grid-cols-2">
                    <Field id="search-name" label="Search name" full>
                      <Input
                        id="search-name"
                        required
                        maxLength={80}
                        value={name}
                        onChange={(event) => setName(event.currentTarget.value)}
                        placeholder="Give your search a name"
                      />
                    </Field>
                    {!search && !draft && (
                      <Field id="search-category" label="What are you searching for?" full>
                        <NativeSelect
                          id="search-category"
                          value={definition.category}
                          onChange={(event) => {
                            chooseCategory(event.currentTarget.value);
                          }}
                        >
                          {SEARCH_TEMPLATES.map((item) => (
                            <NativeSelectOption key={item.category} value={item.category}>
                              {item.title}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      </Field>
                    )}
                    <fieldset className="col-span-full space-y-2">
                      <legend className="mb-2 text-sm font-medium">Marketplaces</legend>
                      <div className="grid grid-cols-2 gap-2">
                        {MARKETPLACES.map((platform) => (
                          <label
                            key={platform.id}
                            className={`flex min-w-0 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 ${marketplaces.includes(platform.id) ? "border-black" : "border-input hover:border-black/50"}`}
                          >
                            <MarketplaceLogo source={platform.id} className="size-5 grayscale" />
                            <span className="min-w-0 flex-1">
                              {platform.id === "facebook_marketplace" ? "Facebook" : platform.name}
                            </span>
                            <Checkbox
                              className="size-4 shrink-0 accent-black"
                              checked={marketplaces.includes(platform.id)}
                              onChange={(event) =>
                                setMarketplaces((current) =>
                                  event.currentTarget.checked
                                    ? [...current, platform.id]
                                    : current.filter((id) => id !== platform.id),
                                )
                              }
                            />
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <div className="col-span-full space-y-2">
                      <Label htmlFor="model-scope">Models to include</Label>
                      <NativeSelect
                        id="model-scope"
                        value={discovery?.scope ?? "help_choose"}
                        onChange={(event) => {
                          changeScope(event.currentTarget.value);
                        }}
                      >
                        <NativeSelectOption value="help_choose">Help me choose</NativeSelectOption>
                        <NativeSelectOption value="alternatives">
                          This model or similar
                        </NativeSelectOption>
                        <NativeSelectOption value="exact">This model only</NativeSelectOption>
                      </NativeSelect>
                      <Label htmlFor="reference-model">Model you have in mind (optional)</Label>
                      <Input
                        id="reference-model"
                        maxLength={200}
                        value={discovery?.reference_model ?? ""}
                        onChange={(event) => {
                          changeReferenceModel(event.currentTarget.value);
                        }}
                      />
                    </div>
                    <SchemaFields
                      definition={definition}
                      answers={answers}
                      showErrors={showErrors}
                      change={(id, value) =>
                        setAnswers((previous) => ({ ...previous, [id]: value }))
                      }
                    />
                  </fieldset>
                </>
              ) : (
                <div className="space-y-4">
                  <p className="font-semibold">{name}</p>
                  <p className="text-sm">
                    {marketplaces
                      .map((id) => MARKETPLACES.find((platform) => platform.id === id)?.name)
                      .join(", ")}
                  </p>
                  {discovery && (
                    <p className="text-sm">
                      {discovery.scope === "exact"
                        ? "Exact model"
                        : discovery.scope === "alternatives"
                          ? "Suitable alternatives welcome"
                          : "Help me choose"}
                      {discovery.reference_model ? ` · ${discovery.reference_model}` : ""}
                    </p>
                  )}
                  {discovery?.research && (
                    <Disclosure title={<> Buying research </>}>
                      <p className="mt-2">{discovery.research.summary}</p>
                      <ul>
                        {discovery.research.sources.map((source) => (
                          <li key={source.url}>
                            <a href={source.url} target="_blank" rel="noopener noreferrer">
                              {source.title}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </Disclosure>
                  )}
                  <dl className="space-y-3 text-sm">
                    {definition.fields
                      .filter((field) => isVisible(field, values, definition))
                      .map((field) => (
                        <div key={field.id} className="flex justify-between gap-4">
                          <dt className="text-muted-foreground">
                            {field.label}
                            {field.match?.importance === "preferred" ? " (preference)" : ""}
                          </dt>
                          <dd className="text-right font-medium">
                            {formatAnswer(field, values[field.id])}
                          </dd>
                        </div>
                      ))}
                  </dl>
                  <p className="text-xs text-muted-foreground">
                    Saving keeps your requirements. Use Search now when you are ready to check
                    listings.
                  </p>
                </div>
              )}
              <FormError message={validation || error} />
            </DialogBody>
            <DialogFooter>
              {search && phase === "edit" && (
                <Button
                  type="button"
                  variant="ghost"
                  className="sm:mr-auto"
                  disabled={disabled || !removable}
                  title={removable ? "Remove this search" : "Keep at least one search"}
                  onClick={() => setPhase("remove")}
                >
                  Remove
                </Button>
              )}
              {!search && phase === "edit" && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => {
                    void saveDraft();
                  }}
                >
                  Save for later
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={phase === "review" ? () => setPhase("edit") : dismiss}
              >
                {phase === "review" ? "Change details" : "Cancel"}
              </Button>
              <Button type="submit" disabled={disabled}>
                {saving ? "Saving…" : phase === "review" ? "Save search" : "Review search"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function FormError({ message }: { message: string }) {
  return message ? (
    <Alert variant="destructive">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  ) : null;
}
