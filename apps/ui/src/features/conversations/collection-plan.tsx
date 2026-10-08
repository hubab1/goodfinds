import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { useRef, useState } from "react";
import type { CollectionPlan, Conversation } from "@goodfinds/contracts/seller-conversation";
import { collectionPlanSchema } from "@goodfinds/contracts/seller-conversation";
import { errorMessage } from "@goodfinds/contracts/state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";

export function CollectionPlanEditor({
  conversation,
  busy,
  save,
  bought,
}: {
  conversation: Conversation;
  busy: boolean;
  save: (plan: CollectionPlan, prepare: boolean) => Promise<void>;
  bought: () => void;
}) {
  const [plan, setPlan] = useState<CollectionPlan>(
    () =>
      conversation.collection_plan ?? {
        purpose: "collection",
        status: "draft",
        when: null,
        pickup_location: null,
        demonstration: null,
        evidence: null,
        seller_message_id: null,
        provenance: "user_reported",
      },
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const disabled = busy || saving;
  const changed = (values: Partial<CollectionPlan>) => {
    setPlan((previous) => ({
      ...previous,
      ...(previous.status === "confirmed" && !("status" in values) && !("evidence" in values)
        ? { status: "draft" as const, evidence: null }
        : {}),
      ...values,
      provenance: "user_reported",
      seller_message_id: null,
    }));
    setError("");
  };
  const savePlan = async (prepare: boolean) => {
    if (disabled || submitting.current) return;
    const parsed = collectionPlanSchema.safeParse(plan);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the plan details");
      return;
    }
    submitting.current = true;
    setSaving(true);
    try {
      await save(parsed.data, prepare);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };
  const when = (values: Partial<NonNullable<CollectionPlan["when"]>>) =>
    changed({
      when: {
        date: "",
        time: null,
        end_time: null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...plan.when,
        ...values,
      },
    });
  return (
    <form
      className="space-y-3 rounded-lg border p-3"
      aria-labelledby="collection-plan-heading"
      onSubmit={(event) => {
        event.preventDefault();
        void savePlan(false);
      }}
    >
      <h3 id="collection-plan-heading" className="font-medium">
        Viewing and collection plan
      </h3>
      <p className="text-xs">
        Agreed price stays separate from the asking price. Proposed arrangements need the seller's
        confirmation.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="plan-purpose" label="Arrange">
          <NativeSelect
            id="plan-purpose"
            value={plan.purpose}
            disabled={disabled}
            onChange={(event) =>
              changed({ purpose: event.target.value === "viewing" ? "viewing" : "collection" })
            }
          >
            <NativeSelectOption value="viewing">Viewing and demonstration</NativeSelectOption>
            <NativeSelectOption value="collection">Collection</NativeSelectOption>
          </NativeSelect>
        </FormField>
        <FormField id="plan-status" label="Arrangement status">
          <NativeSelect
            id="plan-status"
            value={plan.status}
            disabled={disabled}
            onChange={(event) =>
              changed({ status: collectionPlanSchema.shape.status.parse(event.target.value) })
            }
          >
            <NativeSelectOption value="draft">Still planning</NativeSelectOption>
            <NativeSelectOption value="proposed">Proposed to seller</NativeSelectOption>
            <NativeSelectOption value="confirmed">Confirmed by both of us</NativeSelectOption>
          </NativeSelect>
        </FormField>
        <FormField id="plan-date" label="Date">
          <Input
            id="plan-date"
            type="date"
            value={plan.when?.date ?? ""}
            disabled={disabled}
            onChange={(event) =>
              event.target.value ? when({ date: event.target.value }) : changed({ when: null })
            }
          />
        </FormField>
        <FormField id="plan-time" label="Time (optional)">
          <Input
            id="plan-time"
            type="time"
            value={plan.when?.time ?? ""}
            disabled={disabled || !plan.when?.date}
            onChange={(event) => when({ time: event.target.value || null, end_time: null })}
          />
        </FormField>
      </div>
      {plan.when && <p className="text-xs">Times use {plan.when.timezone}.</p>}
      <FormField id="plan-place" label="Pickup or viewing location">
        <Input
          id="plan-place"
          value={plan.pickup_location ?? ""}
          placeholder="Ask the seller if unknown"
          disabled={disabled}
          onChange={(event) => changed({ pickup_location: event.target.value || null })}
        />
      </FormField>
      <FormField id="plan-demo" label="What should the seller demonstrate?">
        <Input
          id="plan-demo"
          value={plan.demonstration ?? ""}
          placeholder="For example: espresso extraction and grinder"
          disabled={disabled}
          onChange={(event) => changed({ demonstration: event.target.value || null })}
        />
      </FormField>
      {plan.status === "confirmed" && (
        <FormField id="plan-evidence" label="How was this confirmed?">
          <Input
            id="plan-evidence"
            value={plan.evidence ?? ""}
            disabled={disabled}
            onChange={(event) => changed({ evidence: event.target.value || null })}
          />
          <p className="text-xs">Saved as reported by you.</p>
        </FormField>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={disabled} type="submit">
          Save plan
        </Button>
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => {
            void savePlan(true);
          }}
        >
          Prepare collection message
        </Button>
        <Button size="sm" variant="outline" disabled={disabled} onClick={bought}>
          I've bought this item
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Preparing creates a new message for review. Recording a purchase fulfils its linked
        searches.
      </p>
    </form>
  );
}
