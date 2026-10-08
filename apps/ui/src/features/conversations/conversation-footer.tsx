import { canProposeEvent } from "@goodfinds/contracts/workflow-model";
import { Button } from "@/components/ui/button";
import "@/features/conversations/seller-conversation.css";
import type { SellerConversationModel } from "./use-seller-conversation";

export function ConversationFooter({
  model,
}: {
  model: Pick<
    SellerConversationModel,
    | "current"
    | "workflow"
    | "draftWorkflow"
    | "latestReply"
    | "loaded"
    | "disabled"
    | "manualOnly"
    | "contact"
    | "draft"
    | "draftFormId"
    | "compose"
    | "reconciled"
    | "refresh"
    | "requestSend"
    | "checkReplies"
  >;
}) {
  const {
    current,
    workflow,
    draftWorkflow,
    latestReply,
    loaded,
    disabled,
    manualOnly,
    contact,
    draft,
    draftFormId,
    compose,
    reconciled,
    refresh,
    requestSend,
    checkReplies,
  } = model;
  return compose ? (
    <>
      <Button
        variant="outline"
        disabled={disabled || !loaded || !canProposeEvent(workflow, "save_draft")}
        type="submit"
        form={draftFormId}
      >
        Save draft
      </Button>
      <Button
        disabled={
          disabled ||
          !loaded ||
          !canProposeEvent(draftWorkflow, "request_send") ||
          !reconciled ||
          !contact.message
        }
        onClick={() => {
          void requestSend();
        }}
      >
        {manualOnly
          ? "Prepare message"
          : draft.intent === "arrange"
            ? "Send collection message"
            : current?.first_sent_at || latestReply
              ? "Send reply"
              : draft.intent === "message"
                ? "Send message"
                : "Send offer"}
      </Button>
    </>
  ) : (
    <>
      <Button
        variant="outline"
        disabled={disabled}
        onClick={() => {
          void refresh();
        }}
      >
        Refresh conversation
      </Button>
      {canProposeEvent(workflow, "request_check") && (
        <Button
          disabled={disabled || manualOnly || !contact.message}
          onClick={() => {
            void checkReplies();
          }}
        >
          Check replies
        </Button>
      )}
    </>
  );
}
