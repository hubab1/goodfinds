import { MessageComposer } from "./message-composer";
import { ReplyRecorder } from "./reply-recorder";
import { ConversationMessages } from "./conversation-messages";
import { ConversationFooter } from "./conversation-footer";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { RelativeTime } from "@/relative-time";
import { canProposeEvent } from "@goodfinds/contracts/workflow-model";
import type { RefObject } from "react";
import { MessageCircle } from "lucide-react";
import type { Listing, GoodfindsState } from "@goodfinds/contracts/state";
import type { SellerConversationSummary } from "@goodfinds/contracts/seller-conversation";
import { ResponsiveOverlay } from "@/components/ui/responsive-overlay";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { money, marketplaceUrl, sourceName, pricePeriod } from "@/lib/presentation";
import type { Action } from "@/lib/actions";
import { HostAction } from "@/host-action";
import { ContactOptions } from "@/features/conversations/contact-options";
import { CollectionPlanEditor } from "@/features/conversations/collection-plan";
import "@/features/conversations/seller-conversation.css";
import { useSellerConversation } from "./use-seller-conversation";

export function SellerConversationChip({
  summary,
}: {
  summary: SellerConversationSummary | undefined;
}) {
  return summary &&
    (summary.first_sent_at || summary.pending_action || summary.outcome !== "open") ? (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs">
      <Badge variant="outline">
        <MessageCircle aria-hidden="true" />
        {summary.label}
      </Badge>
      {summary.price_minor !== null && <span>{money(summary.price_minor, summary.currency)}</span>}
    </span>
  ) : null;
}
export function SellerConversationPanel({
  listing,
  searchId,
  state,
  action,
  busy,
  open,
  onOpenChange,
  returnFocus,
  checkOnOpen = false,
}: {
  listing: Listing;
  searchId?: string | undefined;
  state: GoodfindsState;
  action: Action;
  busy: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus: RefObject<HTMLElement | null>;
  checkOnOpen?: boolean;
}) {
  const model = useSellerConversation({
    listing,
    searchId,
    state,
    action,
    busy,
    open,
    checkOnOpen,
  });
  const {
    current,
    pending,
    workflow,
    summary,
    latestReply,
    replyNeedsResponse,
    loaded,
    disabled,
    notice,
    manualOnly,
    preferNativeOffer,
    draft,
    compose,
    suggest,
    recording,
    markedSent,
    copy,
    savePlan,
    setOutcome,
    continuePending,
    cancelPending,
    reviewSavedSuggestion,
    resumeDraft,
    toggleReplyRecorder,
  } = model;
  const collectionPlanEditor =
    current &&
    canProposeEvent(workflow, "arrange") &&
    (current.phase === "accepted" || current.collection_plan) ? (
      <CollectionPlanEditor
        key={`${current.listing_key}:${current.collection_plan ? JSON.stringify(current.collection_plan) : "new"}`}
        conversation={current}
        busy={disabled}
        save={savePlan}
        bought={() => {
          void setOutcome("bought");
        }}
      />
    ) : null;
  const link = marketplaceUrl(listing.url);
  return (
    <ResponsiveOverlay
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
      title={
        compose
          ? draft.intent === "arrange"
            ? "Review collection message"
            : current?.first_sent_at || latestReply
              ? "Review reply"
              : "Review message"
          : "Conversation"
      }
      description={
        state.mode === "sample"
          ? "Fictional sample · no seller is contacted"
          : "Write a message to the seller."
      }
      footer={<ConversationFooter model={model} />}
    >
      <div className="seller_conversation-panel">
        <ContactOptions listing={listing} state={state} expanded={true} />
        {preferNativeOffer && (
          <p className="text-sm">
            Use the platform offer form first and include a personal message. If it has no note
            field, prepare a separate seller message below using the same amount.
          </p>
        )}
        <div className="seller_conversation-listing">
          <div>
            <strong>{listing.title}</strong>
            <p>
              {listing.seller_name ?? "Seller"} · {sourceName(listing.source)}
            </p>
          </div>
          <div>
            {money(listing.price_minor, listing.currency ?? "GBP")}
            {pricePeriod(listing.price_period)}
            <small>Asking price</small>
          </div>
        </div>
        {notice && (
          <output className="seller_conversation-notice" aria-live="polite">
            {notice}
          </output>
        )}
        {!loaded ? (
          <p>Loading conversation…</p>
        ) : compose ? (
          <MessageComposer model={model} listing={listing} />
        ) : (
          <>
            <SellerConversationChip summary={summary} />
            {current?.agreed_price_minor !== null && current?.agreed_price_minor !== undefined && (
              <p>
                Agreed {money(current.agreed_price_minor, draft.currency)}
                {pricePeriod(listing.price_period)} · purchase{" "}
                {current.outcome === "bought" ? "recorded" : "not yet recorded"}
              </p>
            )}
            {collectionPlanEditor}
            <dl className="seller_conversation-times">
              <div>
                <dt>First message</dt>
                <dd>
                  {current?.first_sent_at ? (
                    <RelativeTime value={current.first_sent_at} />
                  ) : (
                    "Not contacted"
                  )}
                </dd>
              </div>
              <div>
                <dt>Last checked</dt>
                <dd>
                  <RelativeTime value={current?.last_checked_at} />
                </dd>
              </div>
            </dl>
            {pending && (
              <div className="seller_conversation-notice">
                <strong>{pending.kind === "check" ? "Reply check pending" : summary?.label}</strong>
                <p>
                  {pending.reason ?? "A request is separate from a confirmed platform message."}
                </p>
                {pending.draft && (
                  <p className="seller_conversation-message">{pending.draft.text}</p>
                )}
                <div className="seller_conversation-actions">
                  {pending.draft && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        void copy(pending.draft?.text ?? "");
                      }}
                    >
                      Copy message
                    </Button>
                  )}
                  {["awaiting_handoff", "requested", "uncertain"].includes(pending.status) &&
                    !manualOnly && (
                      <Button
                        size="sm"
                        disabled={disabled}
                        onClick={() => {
                          void continuePending();
                        }}
                      >
                        {pending.status === "uncertain" ? "Check send" : "Continue"}
                      </Button>
                    )}
                  {canProposeEvent(workflow, "cancel") && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => {
                        void cancelPending();
                      }}
                    >
                      Cancel request
                    </Button>
                  )}
                  {pending.draft &&
                    ["awaiting_handoff", "requested", "uncertain"].includes(pending.status) && (
                      <Button
                        size="sm"
                        disabled={disabled}
                        onClick={() => {
                          void markedSent();
                        }}
                      >
                        {state.mode === "sample"
                          ? "Practice: mark sent"
                          : "I sent this exact message"}
                      </Button>
                    )}
                </div>
              </div>
            )}
            <div className="seller_conversation-actions">
              {!pending && current?.outcome === "open" && (
                <Button
                  size="sm"
                  onClick={() => {
                    resumeDraft();
                  }}
                >
                  {latestReply && current.draft?.responds_to !== latestReply.id
                    ? "Write reply"
                    : current.draft
                      ? "Resume draft"
                      : "Write offer"}
                </Button>
              )}
              {!pending &&
                current?.outcome === "open" &&
                current.draft &&
                current.draft.text !== draft.text && (
                  <Button
                    size="sm"
                    onClick={() => {
                      reviewSavedSuggestion();
                    }}
                  >
                    Review saved suggestion
                  </Button>
                )}
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => {
                  toggleReplyRecorder();
                }}
              >
                Record seller reply
              </Button>
              {link && state.mode !== "sample" && (
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonVariants({
                    size: "sm",
                    variant: "outline",
                  })}
                >
                  Open listing
                </a>
              )}
            </div>
            {!pending &&
              latestReply &&
              replyNeedsResponse &&
              current?.phase !== "accepted" &&
              current?.outcome === "open" && (
                <div className="seller_conversation-suggestions">
                  <p>Suggested next reply · review before sending</p>
                  <div className="seller_conversation-actions">
                    {!latestReply.facets.unclear &&
                      latestReply.facets.price_minor !== null &&
                      ["counter", "firm"].includes(latestReply.facets.price) && (
                        <Button
                          size="sm"
                          onClick={() => suggest("accept", latestReply.facets.price_minor)}
                        >
                          Accept {money(latestReply.facets.price_minor, draft.currency)}
                        </Button>
                      )}
                    <Button size="sm" variant="outline" onClick={() => suggest("offer")}>
                      Make another offer
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => suggest("message")}>
                      Answer question
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => suggest("decline")}>
                      Decline
                    </Button>
                  </div>
                </div>
              )}
            {!pending &&
              latestReply &&
              replyNeedsResponse &&
              !manualOnly &&
              current?.outcome === "open" && (
                <HostAction
                  disabled={disabled}
                  request={`Use Goodfinds's marketplace-shopping seller_conversation guidance to read get_goodfinds_seller_conversation for listing ${JSON.stringify(listing.key)} in ${state.mode} mode. Suggest a concise reply to the latest seller message, answering each price, collection and information intent. Preserve my stated terms and leave unknown commitments as questions. Save only a draft with save_goodfinds_seller_message_draft, current expected_version and responds_to. Do not create a send action or send a platform message. Show me the suggested wording for review.`}
                >
                  Suggest reply
                </HostAction>
              )}
            {recording && <ReplyRecorder model={model} />}
            <ConversationMessages model={model} listing={listing} />
            {current && !pending && (
              <>
                <div className="seller_conversation-field">
                  <Label htmlFor="seller_conversation-outcome">Outcome</Label>
                  <NativeSelect
                    id="seller_conversation-outcome"
                    value={current.outcome}
                    disabled={disabled}
                    onChange={(e) => {
                      void setOutcome(e.target.value);
                    }}
                  >
                    <NativeSelectOption value="open">Open</NativeSelectOption>
                    <NativeSelectOption value="bought">Bought</NativeSelectOption>
                    <NativeSelectOption value="withdrawn">Withdrawn</NativeSelectOption>
                    <NativeSelectOption value="unavailable">Unavailable</NativeSelectOption>
                  </NativeSelect>
                  <small>An accepted offer does not mark the item bought.</small>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </ResponsiveOverlay>
  );
}
