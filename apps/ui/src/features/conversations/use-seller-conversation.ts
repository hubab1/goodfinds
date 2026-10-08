import { sellerWorkflow } from "@goodfinds/contracts/seller-action-model";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import type { Listing, GoodfindsState } from "@goodfinds/contracts/state";
import { errorMessage } from "@goodfinds/contracts/state";
import {
  EMPTY_FACETS,
  currencyDivisor,
  localDay,
  sellerMessageDraftSchema,
  sellerSummary,
  offerMessage,
  pendingAction,
} from "@goodfinds/contracts/seller-conversation";
import type { Conversation, SellerMessageDraft } from "@goodfinds/contracts/seller-conversation";
import { requestHostAction, subscribeToState, requireHostActions } from "@/lib/client";
import {
  initialSellerMessageDraft,
  sellerRequest,
  offerDefaults,
  offerVerificationChecks,
} from "@/lib/seller-conversation";
import { openingQuestions } from "@goodfinds/contracts/verification";
import { openingMessagePrice, openingOfferPrice } from "@goodfinds/contracts/buying-next-steps";
import type { Action } from "@/lib/actions";
import { useContactReadiness } from "./use-contact-readiness";
import { conversationSchema } from "@goodfinds/contracts/seller-conversation";
import type { CollectionPlan } from "@goodfinds/contracts/seller-conversation";

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
}
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/London";
type Facets = typeof EMPTY_FACETS;

export type ConversationControllerProps = {
  listing: Listing;
  searchId?: string | undefined;
  state: GoodfindsState;
  action: Action;
  busy: boolean;
  open: boolean;
  checkOnOpen?: boolean;
};
export function useSellerConversation({
  listing,
  searchId,
  state,
  action,
  busy,
  open,
  checkOnOpen = false,
}: ConversationControllerProps) {
  const [fetched, setFetched] = useState<Conversation>();
  const [loaded, setLoaded] = useState(false);
  const defaults = offerDefaults(listing, state, searchId);
  const checks = offerVerificationChecks(listing, state, searchId);
  const questions = openingQuestions(checks);
  const [customQuestion, setCustomQuestion] = useState("");
  const [thresholdSearchId, setThresholdSearchId] = useState(defaults.search?.id ?? "");
  const thresholdSearch = defaults.choices.find((search) => search.id === thresholdSearchId);
  const [draft, setDraft] = useState<SellerMessageDraft>(() =>
    initialSellerMessageDraft(listing, defaults.price_minor, questions),
  );
  const [compose, setCompose] = useState(true);
  const [customWording, setCustomWording] = useState(false),
    [reconciled, setReconciled] = useState(true);
  const [working, setWorking] = useState(false),
    [notice, setNotice] = useState("");
  const [recording, setRecording] = useState(false),
    [replyText, setReplyText] = useState(""),
    [facets, setFacets] = useState<Facets>({ ...EMPTY_FACETS });
  const [correction, setCorrection] = useState<string | null>(null),
    [counter, setCounter] = useState("");
  const [dayChoice, setDayChoice] = useState("none");
  const lock = useRef(false);
  const draftFormId = useId();
  const checkedOnOpen = useRef(false);
  const current =
    state.seller_conversation?.listing_key === listing.key &&
    (!fetched || state.seller_conversation.version >= fetched.version)
      ? state.seller_conversation
      : fetched;
  const pending = current ? pendingAction(current) : undefined;
  const workflow = current
    ? sellerWorkflow(current, {
        now: Date.now(),
        config: state.config,
        mode: state.mode,
        context_id: state.access_context,
        availability: listing.availability,
        expected_version: current.version,
      })
    : undefined;
  const draftWorkflow = current
    ? sellerWorkflow(
        { ...current, draft },
        {
          now: Date.now(),
          config: state.config,
          mode: state.mode,
          context_id: state.access_context,
          availability: listing.availability,
          expected_version: current.version,
        },
      )
    : undefined;
  const summary = current ? sellerSummary(current) : undefined;
  const latestReply = current?.messages.findLast((m) => m.direction === "incoming");
  const replyNeedsResponse =
    latestReply &&
    !current?.messages.some(
      (m) => m.direction === "outgoing" && m.draft?.responds_to === latestReply.id,
    );
  const disabled = busy || working;
  const firm = /\b(price (?:is )?firm|no offers|non[- ]negotiable)\b/iu.test(
    listing.description ?? "",
  );
  const manualOnly =
    state.mode === "sample" ||
    (listing.source ?? "facebook_marketplace") !== "facebook_marketplace";
  const contact = useContactReadiness(listing, state);
  const preferNativeOffer =
    state.mode !== "sample" && manualOnly && contact.offer && draft.intent === "offer";
  async function perform(
    command: () => Promise<GoodfindsState | undefined>,
  ): Promise<Conversation | undefined> {
    const next = await command();
    if (next?.seller_conversation) {
      setFetched(next.seller_conversation);
      return next.seller_conversation;
    }
    setNotice("Could not complete that action. Refresh the conversation before trying again.");
    return undefined;
  }
  async function refresh(resetDraft = false) {
    if (lock.current) return;
    lock.current = true;
    setWorking(true);
    try {
      const c = await perform(() =>
        action("get_goodfinds_seller_conversation", { listing_key: listing.key }),
      );
      if (c) {
        setLoaded(true);
        if (resetDraft || !loaded) {
          setDraft(
            c.draft ?? {
              ...initialSellerMessageDraft(listing, defaults.price_minor, questions),
              search_id: searchId ?? defaults.search?.id ?? null,
            },
          );
          setCompose(
            c.outcome === "open" && !c.first_sent_at && !c.actions.length && !c.messages.length,
          );
          setDayChoice(c.draft?.collection ? "custom" : "none");
          setCustomWording(Boolean(c.draft));
          setReconciled(true);
        }
      }
    } finally {
      lock.current = false;
      setWorking(false);
    }
  }
  const loadOnOpen = useEffectEvent(() => {
    void refresh();
  });
  useEffect(() => {
    if (open) loadOnOpen();
  }, [open]);
  const checkSelectedAction = useEffectEvent(() => {
    void check();
  });
  useEffect(() => {
    if (!open) checkedOnOpen.current = false;
    if (
      open &&
      loaded &&
      checkOnOpen &&
      current &&
      !pending &&
      !manualOnly &&
      contact.message &&
      !checkedOnOpen.current
    ) {
      checkedOnOpen.current = true;
      checkSelectedAction();
    }
  }, [open, loaded, checkOnOpen, current, pending, manualOnly, contact.message]);
  useEffect(
    () =>
      subscribeToState((next) => {
        const observed = next.seller_conversation;
        if (next.mode === state.mode && observed?.listing_key === listing.key) {
          setFetched((previous) =>
            !previous || observed.version > previous.version ? observed : previous,
          );
        }
      }),
    [listing.key, state.mode],
  );
  function terms(values: Partial<SellerMessageDraft>) {
    const next = { ...draft, ...values };
    if (next.intent !== "accept" && next.intent !== "arrange") {
      next.collection = null;
      setDayChoice("none");
    }
    if (customWording) setReconciled(false);
    else next.text = offerMessage(next, listing.title);
    setDraft(next);
  }
  function editCollection(values: Partial<NonNullable<SellerMessageDraft["collection"]>>) {
    terms({
      collection: {
        date: localDay(Date.now(), timezone),
        time: null,
        end_time: null,
        timezone,
        ...draft.collection,
        ...values,
      },
    });
  }
  function suggest(intent: SellerMessageDraft["intent"], price: number | null = draft.price_minor) {
    const next = {
      ...draft,
      intent,
      price_minor: intent === "decline" ? null : price,
      collection: intent === "decline" ? null : draft.collection,
      responds_to: latestReply?.id ?? null,
    };
    next.text = offerMessage(next, listing.title);
    if (latestReply?.facets.collection !== "none" && !next.collection && intent === "accept")
      next.text += " What collection time would suit you?";
    setDraft(next);
    setDayChoice(next.collection ? "custom" : "none");
    setCompose(true);
    setCustomWording(false);
    setReconciled(true);
    setNotice("Message ready to review.");
  }
  async function handoff(c: Conversation, a: NonNullable<typeof pending>) {
    if (manualOnly) {
      setNotice(
        state.mode === "sample"
          ? "Sample practice only. Copy the fictional message or record it as sent below."
          : "Copy this message and open the listing. Record it below after you send it.",
      );
      return;
    }
    const request = sellerRequest(c, a, state.mode);
    try {
      await requestHostAction(request);
      await perform(() =>
        action("report_goodfinds_seller_action_handoff", {
          listing_key: listing.key,
          action_id: a.id,
        }),
      );
      setNotice(a.kind === "send" ? "Message queued." : "Reply check queued.");
    } catch (error) {
      setNotice(`${errorMessage(error)} The saved action is retained; refresh before continuing.`);
    }
  }
  async function save(send = false) {
    if (lock.current || !current) return;
    lock.current = true;
    setWorking(true);
    setNotice("");
    try {
      if (send && !manualOnly) await requireHostActions();
      if (send && !contact.message)
        throw new Error(contact.reason || "Seller messaging is unavailable for this listing");
      if (!reconciled)
        throw new Error("Review your edited wording against the changed terms first.");
      const value = sellerMessageDraftSchema.parse({
        ...draft,
        search_id: draft.search_id ?? searchId ?? defaults.search?.id ?? null,
      });
      const saved = await perform(() =>
        action("save_goodfinds_seller_message_draft", {
          listing_key: listing.key,
          expected_version: current.version,
          draft: value,
        }),
      );
      if (!saved) return;
      if (!send) {
        setCompose(false);
        setNotice("Draft saved. The seller has not been contacted.");
        return;
      }
      const requested = await perform(() =>
        action("request_goodfinds_seller_action", {
          listing_key: listing.key,
          expected_version: saved.version,
          request_id: crypto.randomUUID(),
          kind: "send",
        }),
      );
      const a = requested ? pendingAction(requested) : undefined;
      if (requested && a) {
        setCompose(false);
        await handoff(requested, a);
      }
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      lock.current = false;
      setWorking(false);
    }
  }
  async function check() {
    if (lock.current || !current) return;
    lock.current = true;
    setWorking(true);
    setNotice("");
    try {
      if (!manualOnly) await requireHostActions();
      const c = await perform(() =>
        action("request_goodfinds_seller_action", {
          listing_key: listing.key,
          expected_version: current.version,
          request_id: crypto.randomUUID(),
          kind: "check",
        }),
      );
      const a = c ? pendingAction(c) : undefined;
      if (c && a) await handoff(c, a);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      lock.current = false;
      setWorking(false);
    }
  }
  async function recordReply() {
    if (!current || lock.current) return;
    lock.current = true;
    setWorking(true);
    try {
      const price =
        ["accept", "counter", "firm"].includes(facets.price) && counter.trim()
          ? Math.round(Number(counter) * currencyDivisor(draft.currency))
          : null;
      const value = { ...facets, price_minor: price, supporting_text: replyText };
      const c = await perform(() =>
        action(
          correction
            ? "correct_goodfinds_reply_interpretation"
            : "record_goodfinds_user_reported_message",
          {
            listing_key: listing.key,
            ...(correction
              ? { expected_version: current.version, message_id: correction, facets: value }
              : {
                  expected_version: current.version,
                  direction: "incoming",
                  message: {
                    external_id: crypto.randomUUID(),
                    text: replyText,
                    platform_at: null,
                    facets: value,
                  },
                }),
          },
        ),
      );
      if (c) {
        setRecording(false);
        setCorrection(null);
        setReplyText("");
        setNotice(
          correction
            ? "Correction saved with its original history."
            : "Reply saved as reported by you.",
        );
      }
    } finally {
      lock.current = false;
      setWorking(false);
    }
  }
  async function markedSent() {
    if (!current || !pending?.draft || lock.current) return;
    const exactDraft = pending.draft;
    lock.current = true;
    setWorking(true);
    try {
      const recorded = await perform(() =>
        action("record_goodfinds_user_reported_message", {
          listing_key: listing.key,
          expected_version: current.version,
          direction: "outgoing",
          action_id: pending.id,
          message: {
            external_id: pending.id,
            text: exactDraft.text,
            platform_at: null,
            facets: EMPTY_FACETS,
          },
        }),
      );
      if (recorded) setNotice("Marked as sent by you. Not yet checked on the marketplace.");
    } finally {
      lock.current = false;
      setWorking(false);
    }
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied. Copying does not contact the seller.");
    } catch {
      setNotice("Select and copy the message text below.");
    }
  }

  async function savePlan(plan: CollectionPlan, prepare: boolean) {
    if (!current) return;
    const saved = await perform(() =>
      action("save_goodfinds_collection_plan", {
        listing_key: listing.key,
        expected_version: current.version,
        plan,
      }),
    );
    if (saved && prepare) {
      const prepared = await perform(() =>
        action("prepare_goodfinds_collection_message", {
          listing_key: listing.key,
          expected_version: saved.version,
        }),
      );
      if (prepared?.draft) {
        setDraft(prepared.draft);
        setCompose(true);
        setCustomWording(false);
        setReconciled(true);
        setDayChoice(prepared.draft.collection ? "custom" : "none");
      }
    }
  }
  async function setOutcome(value: string) {
    const parsed = conversationSchema.shape.outcome.safeParse(value);
    if (!current || !parsed.success) return;
    await perform(() =>
      action("set_goodfinds_buying_outcome", {
        listing_key: listing.key,
        expected_version: current.version,
        outcome: parsed.data,
        ...(parsed.data === "bought"
          ? {
              search_ids: current.search_ids.length
                ? current.search_ids
                : searchId
                  ? [searchId]
                  : defaults.search
                    ? [defaults.search.id]
                    : [],
            }
          : {}),
      }),
    );
  }
  async function continuePending() {
    if (!current || !pending || lock.current) return;
    lock.current = true;
    setWorking(true);
    try {
      await handoff(current, pending);
    } finally {
      lock.current = false;
      setWorking(false);
    }
  }
  async function cancelPending() {
    if (!pending) return;
    await perform(() =>
      action("cancel_goodfinds_seller_action", { listing_key: listing.key, action_id: pending.id }),
    );
  }
  function editWording(text: string) {
    setDraft({ ...draft, text });
    setCustomWording(true);
  }
  function resetOpening() {
    setDraft({
      ...initialSellerMessageDraft(listing, defaults.price_minor, questions),
      search_id: searchId ?? defaults.search?.id ?? null,
    });
    setDayChoice("none");
    setThresholdSearchId(defaults.search?.id ?? "");
    setCustomWording(false);
    setReconciled(true);
  }
  function regenerateWording() {
    setDraft({ ...draft, text: offerMessage(draft, listing.title) });
    setCustomWording(false);
    setReconciled(true);
  }
  function chooseThreshold(id: string) {
    const search = defaults.choices.find((choice) => choice.id === id);
    setThresholdSearchId(id);
    if (search) {
      const price = openingMessagePrice(listing, openingOfferPrice(listing, search));
      terms({
        price_minor: price,
        intent: price === null ? "message" : "offer",
        search_id: search.id,
      });
    }
  }
  function chooseDay(choice: string) {
    setDayChoice(choice);
    if (choice === "none") terms({ collection: null });
    else
      editCollection({
        date:
          choice === "tomorrow"
            ? nextDay(localDay(Date.now(), timezone))
            : localDay(Date.now(), timezone),
        time: null,
        end_time: null,
      });
  }
  function reviewSavedSuggestion() {
    if (!current?.draft) return;
    setDraft(current.draft);
    setCompose(true);
    setCustomWording(true);
    setReconciled(true);
    setDayChoice(current.draft.collection ? "custom" : "none");
  }
  function resumeDraft() {
    if (latestReply && current?.draft?.responds_to !== latestReply.id) suggest("message");
    else setCompose(true);
    setNotice("");
  }
  function toggleReplyRecorder() {
    setRecording(!recording);
    setCorrection(null);
    setReplyText("");
    setFacets({ ...EMPTY_FACETS });
    setCounter("");
  }
  function correctReply(message: Conversation["messages"][number]) {
    setRecording(true);
    setCorrection(message.id);
    setReplyText(message.text);
    setFacets({ ...message.facets });
    setCounter(
      message.facets.price_minor === null
        ? ""
        : String(message.facets.price_minor / currencyDivisor(draft.currency)),
    );
  }
  return {
    current,
    pending,
    workflow,
    draftWorkflow,
    summary,
    latestReply,
    replyNeedsResponse,
    loaded,
    disabled,
    notice,
    manualOnly,
    contact,
    preferNativeOffer,
    draft,
    draftFormId,
    compose,
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
    suggest,
    recording,
    replyText,
    setReplyText,
    facets,
    setFacets,
    correction,
    counter,
    setCounter,
    recordReply,
    markedSent,
    copy,
    refresh,
    savePlan,
    setOutcome,
    continuePending,
    cancelPending,
    editWording,
    resetOpening,
    regenerateWording,
    chooseThreshold,
    chooseDay,
    reviewSavedSuggestion,
    resumeDraft,
    toggleReplyRecorder,
    correctReply,
    saveDraft: () => save(),
    requestSend: () => save(true),
    checkReplies: check,
  };
}
export type SellerConversationModel = ReturnType<typeof useSellerConversation>;
