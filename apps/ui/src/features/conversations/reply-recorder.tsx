import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { replyFacetsSchema, currencyDivisor } from "@goodfinds/contracts/seller-conversation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import "@/features/conversations/seller-conversation.css";
import type { SellerConversationModel } from "./use-seller-conversation";

export function ReplyRecorder({
  model,
}: {
  model: Pick<
    SellerConversationModel,
    | "disabled"
    | "draft"
    | "replyText"
    | "setReplyText"
    | "facets"
    | "setFacets"
    | "correction"
    | "counter"
    | "setCounter"
    | "recordReply"
  >;
}) {
  const {
    disabled,
    draft,
    replyText,
    setReplyText,
    facets,
    setFacets,
    correction,
    counter,
    setCounter,
    recordReply,
  } = model;
  return (
    <form
      className="seller_conversation-record"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && replyText.trim()) void recordReply();
      }}
    >
      <FormField
        id="seller_conversation-reply"
        label={correction ? "Review seller reply" : "Add seller reply"}
      >
        <Textarea
          id="seller_conversation-reply"
          rows={3}
          value={replyText}
          readOnly={Boolean(correction)}
          onChange={(e) => setReplyText(e.target.value)}
          maxLength={5000}
        />
      </FormField>
      <FormField id="seller_conversation-meaning" label="Price response">
        <NativeSelect
          id="seller_conversation-meaning"
          value={facets.unclear ? "unclear" : facets.price}
          onChange={(e) =>
            setFacets({
              ...facets,
              unclear: e.target.value === "unclear",
              price:
                e.target.value === "unclear"
                  ? "none"
                  : replyFacetsSchema.shape.price.parse(e.target.value),
            })
          }
        >
          <NativeSelectOption value="unclear">Unclear — needs review</NativeSelectOption>
          <NativeSelectOption value="none">No price response</NativeSelectOption>
          <NativeSelectOption value="accept">Accepted offer</NativeSelectOption>
          <NativeSelectOption value="counter">Counteroffer</NativeSelectOption>
          <NativeSelectOption value="decline">Declined offer</NativeSelectOption>
          <NativeSelectOption value="firm">Firm price</NativeSelectOption>
        </NativeSelect>
      </FormField>
      {["accept", "counter", "firm"].includes(facets.price) && (
        <Input
          aria-label="Seller price"
          type="number"
          step={1 / currencyDivisor(draft.currency)}
          min="0"
          value={counter}
          onChange={(e) => setCounter(e.target.value)}
          placeholder={`Seller price (${draft.currency})`}
        />
      )}
      <FormField id="seller_conversation-collection-meaning" label="Collection response">
        <NativeSelect
          id="seller_conversation-collection-meaning"
          value={facets.collection}
          onChange={(e) =>
            setFacets({
              ...facets,
              collection: replyFacetsSchema.shape.collection.parse(e.target.value),
            })
          }
        >
          <NativeSelectOption value="none">No collection detail</NativeSelectOption>
          <NativeSelectOption value="question">Asked about collection</NativeSelectOption>
          <NativeSelectOption value="proposal">Suggested collection</NativeSelectOption>
          <NativeSelectOption value="confirmed">Confirmed collection</NativeSelectOption>
        </NativeSelect>
      </FormField>
      <FormField id="seller_conversation-availability" label="Availability">
        <NativeSelect
          id="seller_conversation-availability"
          value={facets.availability}
          onChange={(e) =>
            setFacets({
              ...facets,
              availability: replyFacetsSchema.shape.availability.parse(e.target.value),
            })
          }
        >
          <NativeSelectOption value="unknown">Not stated</NativeSelectOption>
          <NativeSelectOption value="available">Available</NativeSelectOption>
          <NativeSelectOption value="unavailable">Unavailable</NativeSelectOption>
        </NativeSelect>
      </FormField>
      <label className="seller_conversation-checkbox" htmlFor="reply-information-request">
        <Checkbox
          id="reply-information-request"
          checked={facets.information_request}
          onChange={(e) => setFacets({ ...facets, information_request: e.target.checked })}
        />
        Asked another question
      </label>
      <Button size="sm" type="submit" disabled={disabled || !replyText.trim()}>
        {correction ? "Save correction" : "Save reply"}
      </Button>
    </form>
  );
}
