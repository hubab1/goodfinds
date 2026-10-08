import { Disclosure } from "@/components/ui/disclosure";
import { RelativeTime } from "@/relative-time";
import type { Listing } from "@goodfinds/contracts/state";
import { Button } from "@/components/ui/button";
import "@/features/conversations/seller-conversation.css";
import type { SellerConversationModel } from "./use-seller-conversation";

const PRICE_REPLIES = {
  none: null,
  accept: "Offer accepted",
  counter: "Counteroffer",
  decline: "Offer declined",
  firm: "Price is firm",
};
const COLLECTION_REPLIES = {
  none: null,
  question: "Asked about collection",
  proposal: "Suggested collection",
  confirmed: "Collection confirmed",
};
const AVAILABILITY_REPLIES = {
  unknown: null,
  available: "Available",
  unavailable: "Unavailable",
};

export function ConversationMessages({
  model,
  listing,
}: {
  model: Pick<SellerConversationModel, "current" | "disabled" | "facets" | "correctReply">;
  listing: Listing;
}) {
  const { current, disabled, correctReply } = model;
  return (
    <>
      <div className="seller_conversation-history">
        <h3>Messages</h3>
        {current?.messages.length ? (
          current.messages.map((m) => (
            <div
              key={m.id}
              className={`seller_conversation-message ${m.direction === "outgoing" ? "seller_conversation-outgoing" : ""}`}
            >
              <strong>
                {m.direction === "incoming" ? (listing.seller_name ?? "Seller") : "You"}
              </strong>
              <p>{m.text}</p>
              <small>
                {m.platform_at ? (
                  <RelativeTime value={m.platform_at} />
                ) : (
                  <>
                    Added <RelativeTime value={m.observed_at} /> · message time not shown
                  </>
                )}{" "}
                · {m.provenance === "browser" ? "Checked on marketplace" : "Added by you"}
              </small>
              {m.direction === "incoming" && (
                <>
                  <p className="seller_conversation-facets">
                    {[
                      m.facets.unclear ? "Needs review" : PRICE_REPLIES[m.facets.price],
                      COLLECTION_REPLIES[m.facets.collection],
                      m.facets.information_request ? "Asked a question" : null,
                      AVAILABILITY_REPLIES[m.facets.availability],
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <Button
                    size="sm"
                    variant="link"
                    disabled={disabled}
                    onClick={() => {
                      correctReply(m);
                    }}
                  >
                    Review reply
                  </Button>
                </>
              )}
            </div>
          ))
        ) : (
          <p>No messages recorded.</p>
        )}
      </div>
      <Disclosure title={<> Action history ({current?.events.length ?? 0}) </>}>
        <ol className="seller_conversation-events">
          {current?.events.toReversed().map((e) => (
            <li key={e.id}>
              <strong>{e.kind}</strong>
              <small>
                <RelativeTime value={e.observed_at} /> ·{" "}
                {e.actor === "user" ? "You" : e.actor === "assistant" ? "Goodfinds" : "Browser"}
              </small>
              <p>{e.text}</p>
            </li>
          ))}
        </ol>
      </Disclosure>
    </>
  );
}
