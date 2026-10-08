import { verifiedModel } from "@goodfinds/contracts/discovery";
import { useId, useRef, useState } from "react";
import { Menu, MenuTrigger, MenuContent, MenuItem } from "@/components/ui/menu";
import { ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { ResponsiveOverlay } from "@/components/ui/responsive-overlay";
import { DISREGARD_REASONS } from "@/lib/listing-feedback";
import type { Listing, GoodfindsState } from "@goodfinds/contracts/state";
import type { Action } from "@/lib/actions";

export function ListingDisregard({
  listing,
  state,
  action,
  busy,
  preferredWatchId,
  onDisregarded,
}: {
  listing: Listing;
  state: GoodfindsState;
  action: Action;
  busy: boolean;
  preferredWatchId?: string | undefined;
  onDisregarded?: ((id: string) => void) | undefined;
}) {
  const searches = state.searches.filter((search) => search.product === listing.product);
  const selectedWatchId = searches.find((search) => search.id === preferredWatchId)?.id;
  const directWatchId = selectedWatchId ?? (searches.length === 1 ? searches[0]?.id : undefined);
  const [open, setOpen] = useState(false);
  const [searchId, setWatchId] = useState(directWatchId ?? "");
  const [reason, setReason] = useState("Not interested");
  const [detail, setDetail] = useState("");
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const formId = useId();
  const exclusionSearch = searches.find((search) => search.id === searchId);
  const modelUnconfirmed =
    reason === "Exclude this model from this search" &&
    exclusionSearch !== undefined &&
    !verifiedModel(listing, exclusionSearch);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const reasonId = `disregard-reason-${listing.key}`;
  async function disregard(selectedReason: string, selectedId: string) {
    if (
      busy ||
      saving ||
      submitting.current ||
      !searches.some((search) => search.id === selectedId)
    )
      return;
    submitting.current = true;
    setSaving(true);
    try {
      const next = await action("record_goodfinds_listing_feedback", {
        snapshot_revision: state.revision,
        feedback: {
          search_id: selectedId,
          listing_key: listing.key,
          action: "dismiss",
          scope: "search",
          reason: selectedReason,
          ...(selectedReason === "Exclude this model from this search"
            ? { exclude_model: true }
            : {}),
        },
      });
      if (next) {
        const event = next.config.feedback.findLast(
          (item) =>
            item.search_id === selectedId &&
            item.listing_key === listing.key &&
            item.action === "dismiss" &&
            !item.undone,
        );
        if (event) onDisregarded?.(event.id);
        setOpen(false);
      }
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }
  function chooseReason(selectedReason: string, fromMenu = false) {
    returnFocus.current = fromMenu ? menuTrigger.current : trigger.current;
    if (
      selectedReason !== "Other" &&
      directWatchId &&
      (selectedReason !== "Exclude this model from this search" ||
        searches.some((search) => search.id === directWatchId && verifiedModel(listing, search)))
    ) {
      void disregard(selectedReason, directWatchId);
      return;
    }
    setWatchId(directWatchId ?? "");
    setReason(selectedReason);
    setDetail("");
    setOpen(true);
  }
  return (
    <>
      <fieldset className="inline-flex min-w-0 border-0 p-0" aria-label="Disregard listing">
        <Button
          ref={trigger}
          size="sm"
          variant="ghost"
          className="rounded-r-none focus-visible:relative focus-visible:z-10"
          disabled={busy || saving || !searches.length}
          onClick={() => chooseReason("Not interested")}
        >
          <X aria-hidden="true" />
          Disregard
        </Button>
        <Menu disabled={busy || saving || !searches.length}>
          <MenuTrigger
            ref={menuTrigger}
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                className="rounded-l-none border-l border-white/30 focus-visible:relative focus-visible:z-10"
              />
            }
            aria-label="Choose a reason to disregard"
          >
            <ChevronDown aria-hidden="true" />
          </MenuTrigger>
          <MenuContent aria-label="Reasons to disregard" finalFocus={() => !open}>
            {DISREGARD_REASONS.map((item) => (
              <MenuItem key={item} onClick={() => chooseReason(item, true)}>
                {item === "Other" ? "Other reason…" : item}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      </fieldset>
      <ResponsiveOverlay
        open={open}
        onOpenChange={setOpen}
        returnFocus={returnFocus}
        title={modelUnconfirmed ? "Model not confirmed" : "Disregard this listing?"}
        description={
          modelUnconfirmed
            ? "We need to confirm this listing’s model before excluding it from future results. You can disregard just this listing instead."
            : reason === "Exclude this model from this search"
              ? "Hide this model and its known aliases from future results in this search. You can undo this."
              : "Hide it from this search. You can undo this."
        }
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={busy || saving || !searchId} type="submit" form={formId}>
              {saving ? "Saving…" : modelUnconfirmed ? "Disregard this listing only" : "Disregard"}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void disregard(
              modelUnconfirmed
                ? "Not interested"
                : reason === "Other"
                  ? detail.trim() || "Not interested"
                  : reason,
              searchId,
            );
          }}
        >
          <p className="text-sm font-medium">{listing.title}</p>
          {searches.length > 1 && !selectedWatchId && (
            <div className="space-y-2">
              <Label htmlFor={`disregard-search-${listing.key}`}>Search</Label>
              <NativeSelect
                id={`disregard-search-${listing.key}`}
                value={searchId}
                onChange={(event) => setWatchId(event.currentTarget.value)}
              >
                <NativeSelectOption value="" disabled>
                  Choose a search
                </NativeSelectOption>
                {searches.map((search) => (
                  <NativeSelectOption key={search.id} value={search.id}>
                    {search.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          {searches.length > 1 && !selectedWatchId && (
            <div className="space-y-2">
              <Label htmlFor={reasonId}>Reason</Label>
              <NativeSelect
                id={reasonId}
                value={reason}
                onChange={(event) => setReason(event.currentTarget.value)}
              >
                <NativeSelectOption value="Not interested">Not interested</NativeSelectOption>
                {DISREGARD_REASONS.map((item) => (
                  <NativeSelectOption key={item} value={item}>
                    {item}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          {reason === "Other" && (
            <div className="space-y-2">
              <Label htmlFor={`${reasonId}-detail`}>Tell us why (optional)</Label>
              <Input
                id={`${reasonId}-detail`}
                value={detail}
                maxLength={1000}
                onChange={(event) => setDetail(event.currentTarget.value)}
              />
            </div>
          )}
        </form>
      </ResponsiveOverlay>
    </>
  );
}
