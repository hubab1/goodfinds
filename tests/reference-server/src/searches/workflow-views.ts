import type { WorkspaceConfiguration } from "../workspace/model.ts";
import type { SearchRun } from "@goodfinds/contracts/search-workflow";
import { searchWorkflow as runWorkflow } from "@goodfinds/contracts/search-run-model";
import { hash } from "../workspace/model.ts";
import { scheduledSearchCheck } from "./scheduled-search.ts";

export function workflowViews(
  config: WorkspaceConfiguration,
  runs: SearchRun[],
  fulfilled: Set<string>,
  now: number,
) {
  const context = (searchId: string, run?: SearchRun) => {
    const search = config.searches.find((s) => s.id === searchId);
    return {
      now,
      search_exists: !!search,
      search_current: !!search && (!run || hash(search) === run.search_revision),
      fulfilled: fulfilled.has(searchId),
      expected_version: run?.version,
      scheduled_allowed:
        run?.trigger === "scheduled"
          ? scheduledSearchCheck(config, searchId, now, fulfilled, [], false).allowed
          : true,
    };
  };
  return {
    search_run_workflows: Object.fromEntries(
      runs.map((run) => [run.id, runWorkflow(run, context(run.search_id, run))]),
    ),
    search_workflows: Object.fromEntries(
      config.searches.map((search) => {
        const run = runs.find(
          (r) => r.search_id === search.id && r.search_revision === hash(search),
        );
        return [
          search.id,
          runWorkflow(run ?? null, { ...context(search.id, run), scheduled_allowed: true }),
        ];
      }),
    ),
  };
}
