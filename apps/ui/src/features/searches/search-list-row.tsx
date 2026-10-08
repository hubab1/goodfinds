import "./search-list.css";
import { Menu, MenuTrigger, MenuContent, MenuItem } from "@/components/ui/menu";
import { canProposeAction, canProposeEvent } from "@goodfinds/contracts/workflow-model";
import type { Workflow } from "@goodfinds/contracts/workflow-model";
import { useState } from "react";
import type { MonitoringSummary } from "@goodfinds/contracts/monitoring";
import { monitoringRequest } from "@goodfinds/contracts/monitoring";
import { Monitoring } from "@/features/searches/monitoring";
import { HostMenuAction } from "@/host-action";
import {
  Ellipsis,
  CircleAlert,
  RotateCcw,
  CalendarClock,
  LoaderCircle,
  MapPin,
  Pause,
  Pencil,
  Play,
  Radius,
  Route,
  Search,
  Square,
} from "lucide-react";
import { ACTIVE_SEARCH_PHASES } from "@goodfinds/contracts/search-workflow";
import type { SearchRun } from "@goodfinds/contracts/search-workflow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  searchBudget,
  searchLocation,
  searchRequirements,
  searchSummary,
} from "@/lib/search-presentation";
import type { GoodfindsState } from "@goodfinds/contracts/state";
import type { Action } from "@/lib/actions";
import { SearchCover } from "@/features/searches/search-cover";
import { RelativeTime } from "@/relative-time";

type SavedSearch = GoodfindsState["searches"][number];

function SearchOptions({
  search,
  busy,
  sample,
  edit,
  toggle,
  onSearch,
  fulfilled,
  monitoring,
  run,
  workflow,
  stop,
}: {
  search: SavedSearch;
  busy: boolean;
  sample: boolean;
  edit: () => void;
  toggle: () => void;
  onSearch: () => void;
  fulfilled: boolean;
  monitoring: MonitoringSummary;
  run?: SearchRun | undefined;
  workflow?: Workflow | undefined;
  stop: () => void;
}) {
  const recurring =
    monitoring.preference === "recurring" || Boolean(monitoring.schedule?.automation_id);
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="icon-sm" />}
        aria-label={`More options for ${search.name}`}
      >
        <Ellipsis aria-hidden="true" />
      </MenuTrigger>
      <MenuContent>
        <MenuItem
          className="justify-start"
          disabled={
            busy || sample || fulfilled || !canProposeAction(workflow, "request_search_run")
          }
          onClick={() => {
            onSearch();
          }}
        >
          <Search aria-hidden="true" />{" "}
          {canProposeEvent(workflow, "resume") ? "Resume search" : "Search now"}
        </MenuItem>
        {!sample &&
          !fulfilled &&
          (!recurring || search.enabled) &&
          ["choice_needed", "saved", "setup_needed", "blocked", "paused"].includes(
            monitoring.status,
          ) && (
            <HostMenuAction
              className="w-full justify-start"
              disabled={busy}
              icon={<CalendarClock aria-hidden="true" />}
              request={monitoringRequest(search.id, "search")}
            >
              {monitoring.next_action === "resume"
                ? "Resume monitoring"
                : monitoring.next_action === "update"
                  ? "Update monitoring"
                  : monitoring.preference === "recurring"
                    ? "Set up monitoring"
                    : "Keep watching"}
            </HostMenuAction>
          )}
        {!sample && monitoring.status === "unverified" && (
          <HostMenuAction
            className="w-full justify-start"
            disabled={busy}
            icon={<CalendarClock aria-hidden="true" />}
            request={monitoringRequest(search.id, "check")}
          >
            Check schedule
          </HostMenuAction>
        )}
        {run && canProposeAction(workflow, "cancel_search_run") && (
          <MenuItem
            className="justify-start"
            disabled={busy}
            onClick={() => {
              stop();
            }}
          >
            <Square aria-hidden="true" /> Stop search
          </MenuItem>
        )}
        <MenuItem
          className="justify-start"
          disabled={busy}
          onClick={() => {
            edit();
          }}
        >
          <Pencil aria-hidden="true" /> Edit search
        </MenuItem>
        {!sample && recurring ? (
          (!search.enabled || monitoring.status !== "paused") && (
            <HostMenuAction
              className="w-full justify-start"
              disabled={busy || (!search.enabled && fulfilled)}
              request={monitoringRequest(search.id, search.enabled ? "disable" : "enable")}
            >
              {search.enabled ? "Pause search" : "Resume search"}
            </HostMenuAction>
          )
        ) : (
          <MenuItem
            className="justify-start"
            disabled={busy}
            onClick={() => {
              toggle();
            }}
          >
            {search.enabled ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
            {search.enabled ? "Pause search" : "Resume search"}
          </MenuItem>
        )}
      </MenuContent>
    </Menu>
  );
}

export function SearchListRow({
  search,
  origin,
  sample,
  revision,
  busy,
  action,
  edit,
  onSearch,
  fulfilled = false,
  monitoring,
  run,
  workflow,
  onListings,
}: {
  search: SavedSearch;
  origin: string;
  sample: boolean;
  revision: string;
  busy: boolean;
  action: Action;
  edit: () => void;
  onSearch: () => void;
  fulfilled?: boolean;
  monitoring: MonitoringSummary;
  run?: SearchRun | undefined;
  workflow?: Workflow | undefined;
  onListings?: ((unseen: boolean) => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = `search-details-${search.id}`;
  const requirements = searchRequirements(search);
  const geography = searchLocation(search, origin);
  const active = run && ACTIVE_SEARCH_PHASES.has(run.phase);
  const activity = active
    ? !run.worker
      ? "Waiting to start"
      : run.phase === "verifying"
        ? "Checking listings"
        : "Searching"
    : null;
  const incomplete = run?.phase === "partial" || run?.phase === "blocked";
  const monitoringActive = monitoring.status === "active" || monitoring.status === "quiet";
  const interruption = incomplete
    ? (run.interruption ?? "The last search ended before it finished.")
    : null;
  return (
    <li className="search-list-row" aria-label={search.name}>
      <SearchCover key={search.cover?.media_id ?? search.product} search={search} compact />
      <div className="min-w-0">
        <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="min-w-0 text-base font-medium leading-snug">
            <button
              type="button"
              className="search-name-button text-left"
              aria-expanded={expanded}
              aria-controls={detailsId}
              onClick={() => setExpanded(!expanded)}
            >
              {search.name}
            </button>
          </h3>
          <button
            type="button"
            className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-2"
            aria-label={`Monitoring for ${search.name}: ${monitoring.label}`}
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded(!expanded)}
          >
            <Badge
              variant="outline"
              className="px-2 py-0.5 text-[11px] font-normal"
              title={
                monitoringActive
                  ? "Automatic searches are on. View details for search times."
                  : "View monitoring details and available actions."
              }
            >
              {monitoring.label}
            </Badge>
          </button>
        </div>
        <p className="search-row-summary text-xs leading-relaxed">{searchSummary(search)}</p>
        <div
          className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs leading-relaxed"
          aria-label="Search area"
        >
          <span className="inline-flex min-w-0 items-start gap-1.5">
            <MapPin className="mt-0.5 size-3.5 shrink-0 stroke-[1.5]" aria-hidden="true" />
            <span className="min-w-0 break-words">
              <span className="sr-only">Location: </span>
              {geography.location}
            </span>
          </span>
          {geography.distances.map((distance) => (
            <span key={distance.label} className="inline-flex min-w-0 items-start gap-1.5">
              {distance.kind === "drive" ? (
                <Route className="mt-0.5 size-3.5 shrink-0 stroke-[1.5]" aria-hidden="true" />
              ) : (
                <Radius className="mt-0.5 size-3.5 shrink-0 stroke-[1.5]" aria-hidden="true" />
              )}
              <span className="min-w-0 break-words">{distance.label}</span>
            </span>
          ))}
        </div>
        {activity && (
          <output className="mt-2 inline-flex items-center gap-1.5 text-xs" aria-live="polite">
            <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
            {activity}
          </output>
        )}
        {incomplete && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
              title={interruption ?? undefined}
              aria-expanded={expanded}
              aria-controls={detailsId}
              onClick={() => setExpanded(true)}
            >
              <CircleAlert className="size-3.5" aria-hidden="true" />
              Search incomplete
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline disabled:opacity-50"
              disabled={
                busy || sample || fulfilled || !canProposeAction(workflow, "request_search_run")
              }
              onClick={onSearch}
            >
              <RotateCcw className="size-3" aria-hidden="true" />
              Retry search
            </button>
          </div>
        )}
      </div>
      <div className="search-row-metrics">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <button
            type="button"
            className="font-medium underline-offset-4 hover:underline"
            onClick={() => onListings?.(false)}
            aria-label={`Show listings for ${search.name}`}
          >
            <span className="tabular-nums">{search.found_count ?? search.tracked_count}</span>{" "}
            {sample ? "sample " : ""}
            {(search.found_count ?? search.tracked_count) === 1 ? "listing" : "listings"}
          </button>
          {search.unseen_count > 0 && (
            <button
              type="button"
              className="font-medium underline-offset-4 hover:underline"
              onClick={() => onListings?.(true)}
              aria-label={`Show ${search.unseen_count} new listings for ${search.name}`}
              title="Listings you haven’t viewed yet"
            >
              <span
                className="mr-1 inline-block size-1.5 rounded-full bg-current"
                aria-hidden="true"
              />
              {search.unseen_count} new
            </button>
          )}
        </div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Last searched</dt>
          <dd className="text-right">
            {search.last_searched_at ? <RelativeTime value={search.last_searched_at} /> : "Not yet"}
          </dd>
          {search.latest_found_at && (
            <>
              <dt className="text-muted-foreground">Last found</dt>
              <dd className="text-right">
                <RelativeTime value={search.latest_found_at} />
              </dd>
            </>
          )}
        </dl>
      </div>
      <div className="search-row-actions">
        <p className="search-row-budget text-base font-medium leading-snug">
          {searchBudget(search) !== "No price limit" && (
            <span className="block text-[11px] font-normal">Up to</span>
          )}
          {searchBudget(search)}
          {search.definition.price.period !== "once" && (
            <span className="block text-[11px] font-normal">
              per {search.definition.price.period}
            </span>
          )}
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="search-details-button"
            aria-label={`${expanded ? "Hide details" : "Details"} for ${search.name}`}
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Hide details" : "Details"}
          </Button>
          <SearchOptions
            search={search}
            fulfilled={fulfilled}
            monitoring={monitoring}
            busy={busy}
            sample={sample}
            edit={edit}
            onSearch={onSearch}
            run={run}
            workflow={workflow}
            stop={() => {
              if (run)
                void action(
                  "cancel_goodfinds_search_run",
                  { request: { run_id: run.id } },
                  "Search stopped",
                );
            }}
            toggle={() => {
              void action(
                "set_goodfinds_search_enabled",
                {
                  search_id: search.id,
                  enabled: !search.enabled,
                  snapshot_revision: revision,
                },
                search.enabled ? "Search paused" : "Search resumed",
              );
            }}
          />
        </div>
      </div>
      <section
        id={detailsId}
        hidden={!expanded}
        className="col-span-full border-t pt-4"
        aria-label={`Search details for ${search.name}`}
      >
        {!sample && (
          <div className="mb-4 border-b pb-4">
            {interruption && (
              <p className="mb-4 text-xs leading-relaxed">
                <strong>Last search:</strong> {interruption}
                {monitoringActive
                  ? " Automatic searches remain on; the next scheduled check can try again."
                  : " Retry when you’re ready."}
              </p>
            )}
            <Monitoring summary={monitoring} revision={revision} busy={busy} action={action} />
          </div>
        )}
        <h4 className="mb-3 text-sm font-medium">Search details</h4>
        <dl className="grid gap-x-8 gap-y-3 @2xl:grid-cols-2">
          {requirements.map((requirement) => (
            <div key={requirement.id} className="min-w-0">
              <dt className="text-xs leading-relaxed">{requirement.label}</dt>
              <dd className="mt-0.5 text-sm font-medium leading-relaxed break-words">
                {requirement.value}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </li>
  );
}
