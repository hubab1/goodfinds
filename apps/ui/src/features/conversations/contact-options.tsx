import { useContactReadiness } from "./use-contact-readiness";
import { useState } from "react";
import { MessageCircle } from "lucide-react";
import type { Listing, GoodfindsState } from "@goodfinds/contracts/state";
import { sellerApproach, validatePlatformOffer } from "@goodfinds/contracts/marketplace-actions";
import { currencyDivisor } from "@goodfinds/contracts/seller-conversation";
import { HostAction } from "@/host-action";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { marketplaceUrl, money, sourceName } from "@/lib/presentation";

export function ContactOptions({
  listing,
  state,
  expanded = false,
}: {
  listing: Listing;
  state: GoodfindsState;
  expanded?: boolean;
}) {
  const [amount, setAmount] = useState("");
  const readiness = useContactReadiness(listing, state);
  if (state.mode === "sample") return null;
  const report = readiness.observation;
  const approach = sellerApproach(readiness);
  const companion = approach === "offer_with_note" || approach === "offer_and_message";
  const source = sourceName(listing.source);
  const request = `Use Goodfinds's marketplace-shopping skill to inspect contact options for saved listing ${JSON.stringify(listing.key)} at ${JSON.stringify(listing.url)}. Read current state and access_context first. Use its selected browser/profile and check the exact listing, availability and host/site access. Update saved availability evidence if it changes. Verify actual signed-in versus guest state using account or protected UI evidence, never cookie existence alone. Record access and sign-in with their report tools. Without sending, inspect whether Message/Ask seller, Make offer, or external call/email controls are available or disabled for this buyer. Record report_goodfinds_listing_contact with this exact listing identity and actual message/offer availability. Inspect any note/message field inside the native offer form and record offer_note separately; it can be usable even when standalone messaging is unavailable. Record message_auth and offer_auth independently; mark not_required only with explicit evidence the guest route is usable without authentication, not merely that its button is visible. If an individual-item offer form is available, observe currency, minimum/maximum/increment and remaining quota, and record offer_limits only with that evidence. Distinguish item price from delivery/protection fees; bundle-only forms remain unknown for this individual listing. Do not infer a 40% Vinted rule without current evidence. If login, challenge or unavailable browser blocks inspection, record unknown and explain the blocker. Do not submit an offer or message, purchase, accept terms, log me out or expose credentials.`;
  if (!readiness.message && !readiness.offer)
    return (
      <div className="space-y-2 text-xs">
        {readiness.check_needed ? (
          <HostAction
            request={request}
            autoStart={expanded}
            icon={<MessageCircle aria-hidden="true" />}
          >
            Check messaging
          </HostAction>
        ) : (
          <p className="text-muted-foreground">{readiness.reason}</p>
        )}
      </div>
    );
  if (!readiness.offer) return null;
  const limits = report?.offer_limits;
  const currency = limits?.currency ?? listing.currency ?? "GBP";
  const value = Number(amount),
    minor = Math.round(value * currencyDivisor(currency));
  const error =
    amount && report
      ? !Number.isFinite(value) || Math.abs(minor / currencyDivisor(currency) - value) > 0.00000001
        ? currencyDivisor(currency) === 1
          ? "Enter a whole amount"
          : `Use up to ${Math.log10(currencyDivisor(currency))} decimal places`
        : validatePlatformOffer(report, minor, currency)
      : "Enter your offer amount";
  const href = marketplaceUrl(listing.url);
  return (
    <details open={expanded || undefined} className="w-full space-y-3 rounded border p-3 text-sm">
      <summary className="cursor-pointer font-medium">Make an offer on {source}</summary>
      <p className="text-xs text-muted-foreground">
        This uses the platform's offer form. You review and submit there; it may include payment or
        purchase commitments. Delivery and buyer fees are separate.
      </p>
      {companion && (
        <p className="text-xs">
          Prefer the formal offer with a personal message, using the offer's note field where
          available or a separate seller message.
        </p>
      )}
      {!limits ? (
        <HostAction request={request}>Check offer limits</HostAction>
      ) : (
        <>
          <p className="text-xs">
            {limits.minimum_minor !== null
              ? `Minimum ${money(limits.minimum_minor, currency)}. `
              : "Minimum not confirmed. "}
            {limits.maximum_minor !== null
              ? `Maximum ${money(limits.maximum_minor, currency)}. `
              : "Maximum not confirmed. "}
            {limits.remaining_offers !== null
              ? `${limits.remaining_offers} offers remaining.`
              : "Remaining offers not confirmed."}
          </p>
          <p className="text-xs text-muted-foreground">
            Only verified limits are checked here. Review other restrictions in the platform form.
          </p>
          <Label htmlFor={`platform-offer-${listing.key}`}>Offer ({currency})</Label>
          <Input
            id={`platform-offer-${listing.key}`}
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.currentTarget.value)}
          />
          {amount && error && (
            <p role="alert" className="text-xs">
              {error}
            </p>
          )}
          {!error && href && (
            <div className="space-y-2">
              <p className="text-xs">
                Enter {money(minor, currency)} in the platform's offer form and review its current
                terms.
              </p>
              <HostAction
                request={`${request} Once fresh checks confirm this buyer can make this offer, prepare the formal offer of ${money(minor, currency)} (${minor} minor units, ${currency}) with a short personal message for my review. Use the same amount in both. Read any saved conversation draft: reuse its wording only if its terms match this amount; otherwise show a new suggestion for review. Prefer the offer form's note field when available; otherwise prepare an unsent separate seller message only if its composer is verified available. If neither message route is available, prepare the offer alone and explain that. Do not add collection, payment or timing commitments I have not supplied. Recheck amount limits, quota and offer-note availability, and inspect existing offer/message history to avoid duplicates. Show the exact amount, text and routes together for review. Stop before submitting either the offer or message or any payment/purchase commitment. A message accompanying an offer does not itself submit a native offer, and completion of one does not prove completion of the other.`}
              >
                {companion ? "Review offer and message" : "Review in platform offer form"}
              </HostAction>
              <a className="underline" href={href} target="_blank" rel="noopener noreferrer">
                Open listing
              </a>
            </div>
          )}
        </>
      )}
    </details>
  );
}
