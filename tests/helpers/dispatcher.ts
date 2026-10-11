import { randomUUID } from "node:crypto";
import type { GoodfindsState } from "@goodfinds/contracts/state";
import { dispatcherPlan } from "@goodfinds/contracts/scheduled-dispatch";
import { fulfilledSearches } from "@goodfinds/contracts/buying-next-steps";
export function dispatcherArgs(
  state: GoodfindsState,
  searchIds: string[],
  receipt: Record<string, unknown>,
  dispatcherId?: string,
) {
  const previous = state.config.dispatchers.find((d) =>
    d.search_ids.some((id) => searchIds.includes(id)),
  );
  const plan = dispatcherPlan(
    state.config,
    searchIds,
    fulfilledSearches(state.seller_conversations),
    Date.parse(state.generated_at),
    state.revision,
  );
  return {
    expected_entity_revision: state.revisions.settings,
    report: {
      plan_revision: state.revision,
      dispatcher_id: dispatcherId ?? previous?.id ?? randomUUID(),
      thread_id: receipt["thread_id"],
      search_ids: searchIds,
      schedule: {
        interval_minutes: plan.interval_minutes,
        rrule: plan.rrule ?? previous?.schedule?.rrule,
        timezone: plan.timezone,
        ...receipt,
      },
    },
  };
}
