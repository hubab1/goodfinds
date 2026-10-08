import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Disclosure } from "@/components/ui/disclosure";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { canProposeEvent } from "@goodfinds/contracts/workflow-model";
import type { Listing } from "@goodfinds/contracts/state";
import { currencyDivisor } from "@goodfinds/contracts/seller-conversation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { targetPrice } from "@/lib/listing-trends";
import { money, pricePeriod } from "@/lib/presentation";
import "@/features/conversations/seller-conversation.css";
import type { SellerConversationModel } from "./use-seller-conversation";

export function MessageComposer({
  model,
  listing,
}: {
  model: Pick<
    SellerConversationModel,
    | "current"
    | "pending"
    | "workflow"
    | "latestReply"
    | "loaded"
    | "disabled"
    | "draft"
    | "draftFormId"
    | "setCompose"
    | "defaults"
    | "checks"
    | "questions"
    | "thresholdSearch"
    | "thresholdSearchId"
    | "customQuestion"
    | "setCustomQuestion"
    | "reconciled"
    | "setReconciled"
    | "dayChoice"
    | "firm"
    | "terms"
    | "editCollection"
    | "editWording"
    | "resetOpening"
    | "regenerateWording"
    | "chooseThreshold"
    | "chooseDay"
    | "saveDraft"
  >;
  listing: Listing;
}) {
  const {
    current,
    pending,
    workflow,
    latestReply,
    loaded,
    disabled,
    draft,
    draftFormId,
    setCompose,
    defaults,
    checks,
    questions,
    thresholdSearch,
    thresholdSearchId,
    customQuestion,
    setCustomQuestion,
    reconciled,
    setReconciled,
    dayChoice,
    firm,
    terms,
    editCollection,
    editWording,
    resetOpening,
    regenerateWording,
    chooseThreshold,
    chooseDay,
    saveDraft,
  } = model;
  return (
    <form
      id={draftFormId}
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && loaded && canProposeEvent(workflow, "save_draft")) void saveDraft();
      }}
    >
      {latestReply && (
        <blockquote className="seller_conversation-message">{latestReply.text}</blockquote>
      )}
      <div className="seller_conversation-field">
        <Label htmlFor="seller_conversation-wording">Message preview</Label>
        <Textarea
          id="seller_conversation-wording"
          rows={4}
          value={draft.text}
          maxLength={5000}
          onChange={(e) => {
            editWording(e.target.value);
          }}
        />
        {!current?.first_sent_at && !latestReply && (
          <Button
            size="sm"
            variant="link"
            disabled={disabled || Boolean(pending)}
            onClick={() => {
              resetOpening();
            }}
          >
            Use short message
          </Button>
        )}
        {!reconciled && (
          <div className="seller_conversation-notice">
            <p>Terms changed after your wording edit. Check that the message matches.</p>
            <div className="seller_conversation-actions">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  regenerateWording();
                }}
              >
                Rewrite message
              </Button>
              <Button size="sm" onClick={() => setReconciled(true)}>
                I’ve reviewed this message
              </Button>
            </div>
          </div>
        )}
      </div>
      <Disclosure
        title={
          <>
            {" "}
            {draft.intent === "accept" || draft.intent === "arrange"
              ? "Price and collection"
              : "Offer (optional)"}
            {draft.price_minor !== null
              ? ` · ${money(draft.price_minor, draft.currency)}`
              : ""}{" "}
          </>
        }
      >
        <div className="space-y-5">
          <div className="seller_conversation-field">
            {defaults.choices.length > 1 && draft.intent !== "arrange" && (
              <>
                <Label htmlFor="seller_conversation-threshold">Use budget from search</Label>
                <NativeSelect
                  id="seller_conversation-threshold"
                  value={thresholdSearchId}
                  onChange={(e) => {
                    chooseThreshold(e.target.value);
                  }}
                >
                  <NativeSelectOption value="" disabled>
                    Choose a search
                  </NativeSelectOption>
                  {defaults.choices.map((search) => (
                    <NativeSelectOption key={search.id} value={search.id}>
                      {search.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </>
            )}
            <Label htmlFor="seller_conversation-price">
              {draft.intent === "arrange" ? "Agreed price" : "Offer price"} ({draft.currency})
            </Label>
            <Input
              id="seller_conversation-price"
              disabled={draft.intent === "arrange"}
              type="number"
              min="0"
              step={1 / currencyDivisor(draft.currency)}
              inputMode="decimal"
              value={
                draft.price_minor === null
                  ? ""
                  : draft.price_minor / currencyDivisor(draft.currency)
              }
              onChange={(e) =>
                terms({
                  intent: e.target.value ? "offer" : "message",
                  price_minor: e.target.value
                    ? Math.round(Number(e.target.value) * currencyDivisor(draft.currency))
                    : null,
                })
              }
            />
            <div className="seller_conversation-actions">
              {(draft.intent === "arrange" ? [] : [5, 10]).map((discount) => (
                <Button
                  key={discount}
                  size="sm"
                  variant="outline"
                  disabled={firm || listing.price_minor === null}
                  onClick={() =>
                    terms({
                      intent: "offer",
                      price_minor: Math.round((listing.price_minor ?? 0) * (1 - discount / 100)),
                    })
                  }
                >
                  {discount}% below asking
                </Button>
              ))}
            </div>
            <small>
              {thresholdSearch &&
                draft.intent !== "arrange" &&
                `Your ${thresholdSearch.name} budget: ${money(targetPrice(thresholdSearch), draft.currency)}${pricePeriod(draft.price_period)}. `}
              {draft.intent === "arrange"
                ? "The agreed price is preserved while you arrange the viewing or collection."
                : firm
                  ? "The seller states a firm price. Consider asking a question before making a lower offer."
                  : defaults.choices.length > 1 && !thresholdSearch
                    ? "Choose a search budget or enter your offer."
                    : "The amount the seller will see. You can edit it before sending."}
            </small>
          </div>
          {listing.product !== "rental" &&
            (draft.intent === "accept" || draft.intent === "arrange") && (
              <div className="seller_conversation-field">
                <Label htmlFor="seller_conversation-day">Collection (optional)</Label>
                <NativeSelect
                  id="seller_conversation-day"
                  value={dayChoice}
                  onChange={(e) => {
                    chooseDay(e.target.value);
                  }}
                >
                  <NativeSelectOption value="none">Not specified</NativeSelectOption>
                  <NativeSelectOption value="today">Today</NativeSelectOption>
                  <NativeSelectOption value="tomorrow">Tomorrow</NativeSelectOption>
                  <NativeSelectOption value="custom">Choose date</NativeSelectOption>
                </NativeSelect>
                {draft.collection && (
                  <>
                    <div className="seller_conversation-collection">
                      {dayChoice === "custom" && (
                        <Input
                          aria-label="Collection date"
                          type="date"
                          value={draft.collection.date}
                          onChange={(e) => editCollection({ date: e.target.value })}
                        />
                      )}
                      <NativeSelect
                        aria-label="Collection time"
                        value={
                          draft.collection.time
                            ? draft.collection.end_time
                              ? "window"
                              : "around"
                            : "flexible"
                        }
                        onChange={(e) =>
                          editCollection({
                            time:
                              e.target.value === "flexible"
                                ? null
                                : (draft.collection?.time ?? "19:00"),
                            end_time: e.target.value === "window" ? "20:00" : null,
                          })
                        }
                      >
                        <NativeSelectOption value="flexible">Flexible that day</NativeSelectOption>
                        <NativeSelectOption value="around">Around a time</NativeSelectOption>
                        <NativeSelectOption value="window">Time window</NativeSelectOption>
                      </NativeSelect>
                      {draft.collection.time && (
                        <Input
                          aria-label="Collection start time"
                          type="time"
                          value={draft.collection.time}
                          onChange={(e) => editCollection({ time: e.target.value })}
                        />
                      )}{" "}
                      {draft.collection.end_time && (
                        <Input
                          aria-label="Collection end time"
                          type="time"
                          value={draft.collection.end_time}
                          onChange={(e) => editCollection({ end_time: e.target.value })}
                        />
                      )}
                    </div>
                    <small>
                      {draft.collection.date} · {draft.collection.timezone}
                    </small>
                  </>
                )}
              </div>
            )}
        </div>
      </Disclosure>
      <Disclosure
        title={<> Questions for the seller · {draft.verification_questions?.length ?? 0} </>}
      >
        <fieldset className="seller_conversation-field">
          <legend className="sr-only">Questions for the seller</legend>
          {checks
            .filter((detail) => detail.state === "confirmed")
            .map((detail) => (
              <p
                key={detail.id}
                className="text-xs text-muted-foreground"
                title={detail.evidence ?? undefined}
              >
                {detail.label} · confirmed from saved evidence
              </p>
            ))}
          {[...new Set([...questions, ...(draft.verification_questions ?? [])])].map((question) => (
            <label key={question} className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={draft.verification_questions?.includes(question) ?? false}
                disabled={
                  (draft.verification_questions?.length ?? 0) >= 30 &&
                  !draft.verification_questions?.includes(question)
                }
                onChange={(e) =>
                  terms({
                    verification_questions: e.target.checked
                      ? [...(draft.verification_questions ?? []), question]
                      : (draft.verification_questions?.filter((value) => value !== question) ?? []),
                  })
                }
              />
              {question}
            </label>
          ))}
          <Label htmlFor="seller_conversation-question">Add a question</Label>
          <Input
            id="seller_conversation-question"
            value={customQuestion}
            maxLength={500}
            onChange={(e) => setCustomQuestion(e.target.value)}
            placeholder="Add anything else you want to ask"
          />
          <div className="seller_conversation-actions">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!customQuestion.trim() || (draft.verification_questions?.length ?? 0) >= 30}
              onClick={() => {
                terms({
                  verification_questions: [
                    ...new Set([...(draft.verification_questions ?? []), customQuestion.trim()]),
                  ],
                });
                setCustomQuestion("");
              }}
            >
              Add question
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => terms({ price_minor: null, intent: "message", collection: null })}
            >
              Ask questions first
            </Button>
          </div>
        </fieldset>
      </Disclosure>
      <Button
        size="sm"
        variant="link"
        onClick={() => {
          setCompose(false);
        }}
      >
        View history
      </Button>
    </form>
  );
}
