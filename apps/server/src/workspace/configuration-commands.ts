import {
  MARKETPLACES,
  accessReportSchema,
  sessionReportSchema,
} from "@goodfinds/contracts/integrations";
import { feedbackInputSchema } from "@goodfinds/contracts/discovery";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { settingsSchema } from "@goodfinds/contracts/state";
import { draftInputSchema } from "@goodfinds/contracts/search-definition";
import { listingContactReportSchema } from "@goodfinds/contracts/marketplace-actions";
import { searchCoverProduct, searchCoverSchema } from "@goodfinds/contracts/search-cover";
import {
  bundledSearchCoverFor,
  isBundledSearchCover,
} from "@goodfinds/contracts/search-cover-presets";
import { hash, iso } from "./model.ts";
import type { WorkspaceConfiguration } from "./model.ts";
import { Clock, Effect } from "effect";
import { validation, ValidationError, MissingSearch } from "./errors.ts";
import { cleanAnswers, normalizeSearch } from "../searches/definition.ts";
import { setMonitoring, recordSchedule } from "../searches/monitoring.ts";
import { recordDispatcher } from "../searches/dispatchers.ts";
import { dispatcherForSearch } from "@goodfinds/contracts/scheduled-dispatch";
import type { HostScheduleObservation } from "@goodfinds/contracts/monitoring";
import { connectionCheckObservationSchema } from "@goodfinds/contracts/connection-checks";
import { ACCESS_CONTEXT } from "./context.ts";
export const updateConfig = Effect.fnUntraced(function* (
  action: string,
  args: Record<string, unknown>,
  config: WorkspaceConfiguration,
  fulfilled: Set<string> = new Set(),
  hostSchedules: Map<string, HostScheduleObservation> = new Map(),
) {
  const candidate = structuredClone(config);
  if (action === "set_monitoring") {
    yield* validation(() => setMonitoring(candidate, args["monitoring"]));
  } else if (action === "report_host_schedule") {
    const now = yield* Clock.currentTimeMillis;
    yield* validation(() => recordSchedule(candidate, args["report"], now));
  } else if (action === "report_dispatcher_schedule") {
    const now = yield* Clock.currentTimeMillis;
    yield* validation(() =>
      recordDispatcher(candidate, args["report"], now, fulfilled, hostSchedules),
    );
  } else if (action === "save_search") {
    const draft = args["draft_id"];
    if (draft && !candidate.drafts.some((item) => item.id === draft))
      return yield* Effect.fail(
        new MissingSearch({ message: "That unfinished search no longer exists" }),
      );
    const search = yield* normalizeSearch(args["search"]),
      index = candidate.searches.findIndex((item) => item.id === search.id),
      previous = candidate.searches[index];
    if (previous) {
      if (!search.marketplaces && previous.marketplaces)
        search.marketplaces = previous.marketplaces;
      if (!search.discovery && previous.discovery) search.discovery = previous.discovery;
      const subjectChanged =
        previous.product !== search.product ||
        searchCoverProduct(previous)?.toLowerCase() !== searchCoverProduct(search)?.toLowerCase();
      const presetChanged =
        previous.product !== "rental" &&
        previous.cover &&
        previous.cover.kind === "generated" &&
        isBundledSearchCover(previous.cover.media_id) &&
        bundledSearchCoverFor(previous)?.media_id !== bundledSearchCoverFor(search)?.media_id;
      if (
        (subjectChanged || presetChanged) &&
        previous.cover &&
        (!search.cover || hash(search.cover) === hash(previous.cover))
      )
        delete search.cover;
      else if (!search.cover && previous.product === search.product && previous.cover)
        search.cover = previous.cover;
      if (
        hash(previous.definition) !== hash(search.definition) &&
        search.definition.version <= previous.definition.version
      )
        return yield* Effect.fail(
          new ValidationError({
            message: "Increase the definition version when changing its fields",
          }),
        );
      candidate.searches[index] = search;
    } else candidate.searches.push(search);
    if (
      search.product === "rental" &&
      search.cover?.location &&
      search.cover.location !== search.values["area"]
    )
      delete search.cover;
    if (draft) candidate.drafts = candidate.drafts.filter((item) => item.id !== draft);
  } else if (action === "set_search_cover") {
    const search = candidate.searches.find((item) => item.id === args["search_id"]);
    if (!search)
      return yield* Effect.fail(new MissingSearch({ message: "That search no longer exists" }));
    if (!("cover" in args))
      return yield* Effect.fail(
        new ValidationError({ message: "Choose a search cover or null to restore the default" }),
      );
    if (args["cover"] === null) delete search.cover;
    else {
      const image = yield* validation(() => searchCoverSchema.parse(args["cover"]));
      if (search.product === "rental" && image.location && image.location !== search.values["area"])
        return yield* Effect.fail(
          new ValidationError({
            message: "The search cover location must match the saved rental area",
          }),
        );
      search.cover = image;
    }
  } else if (action === "save_search_draft") {
    const parsed = yield* validation(() => draftInputSchema.parse(args["draft"])),
      draft = {
        ...parsed,
        id: parsed.id ?? `draft-${(yield* Effect.sync(randomUUID)).slice(0, 8)}`,
        values: yield* cleanAnswers(parsed.definition, parsed.values, true),
      };
    const index = candidate.drafts.findIndex((item) => item.id === draft.id);
    const previous = candidate.drafts[index];
    if (
      previous &&
      hash(previous.definition) !== hash(draft.definition) &&
      draft.definition.version <= previous.definition.version
    )
      return yield* Effect.fail(
        new ValidationError({
          message: "Increase the definition version when changing its fields",
        }),
      );
    if (index < 0) candidate.drafts.push(draft);
    else candidate.drafts[index] = draft;
  } else if (action === "discard_search_draft") {
    candidate.drafts = candidate.drafts.filter((draft) => draft.id !== args["draft_id"]);
  } else if (action === "set_search_enabled" || action === "remove_search") {
    const index = candidate.searches.findIndex((item) => item.id === args["search_id"]),
      search = candidate.searches[index];
    if (!search)
      return yield* Effect.fail(new MissingSearch({ message: "That search no longer exists" }));
    if (action === "set_search_enabled")
      search.enabled = yield* validation(() => z.boolean().parse(args["enabled"]));
    else {
      const dispatcher = dispatcherForSearch(candidate, search.id);
      if (
        candidate.monitoring.some(
          (item) => item.search_id === search.id && item.schedule?.status === "active",
        ) ||
        (dispatcher?.schedule?.status === "active" &&
          dispatcher.search_ids.every(
            (id) =>
              id === search.id ||
              fulfilled.has(id) ||
              !candidate.searches.some((s) => s.id === id && s.enabled) ||
              !candidate.monitoring.some((m) => m.search_id === id && m.preference === "recurring"),
          ))
      )
        return yield* Effect.fail(
          new ValidationError({
            message: "Pause and verify this search's host schedule before removing it",
          }),
        );
      candidate.searches.splice(index, 1);
      candidate.monitoring = candidate.monitoring.filter((item) => item.search_id !== search.id);
      for (const d of candidate.dispatchers)
        d.search_ids = d.search_ids.filter((id) => id !== search.id);
    }
  } else if (
    action === "report_browser_access" ||
    action === "report_marketplace_session" ||
    action === "report_connections" ||
    action === "report_listing_contact"
  ) {
    if (args["context_id"] !== ACCESS_CONTEXT)
      return yield* Effect.fail(
        new ValidationError({ message: "Refresh Goodfinds before reporting browser access" }),
      );
    const now = iso(yield* Clock.currentTimeMillis);
    if (action === "report_connections") {
      const observations = yield* validation(() =>
        z.array(connectionCheckObservationSchema).min(1).max(6).parse(args["reports"]),
      );
      const seen = new Set<string>();
      const routes = new Map<string, typeof observations>();
      for (const observation of observations) {
        const { access, session } = observation;
        const route = routes.get(access.browser) ?? [];
        const previous = route[0]?.access;
        if (
          seen.has(observation.marketplace) ||
          !access.browser_id ||
          (previous &&
            (previous.browser_id !== access.browser_id ||
              previous.host !== access.host ||
              previous.profile !== access.profile)) ||
          (session &&
            (access.status !== "available" ||
              session.marketplace !== observation.marketplace ||
              session.browser !== access.browser ||
              session.browser_id !== access.browser_id ||
              session.host !== access.host ||
              session.profile !== access.profile))
        )
          return yield* Effect.fail(
            new ValidationError({ message: "Check results must match the selected browser." }),
          );
        seen.add(observation.marketplace);
        route.push(observation);
        routes.set(access.browser, route);
      }
      // A blocked website does not mean the connected browser is unavailable.
      // Validate each route before changing either access or account evidence.
      for (const route of routes.values()) {
        const available = route.find((item) => item.access.status === "available");
        const globalFailure = route.some(
          ({ access }) =>
            access.blocked_domains.includes("*") ||
            access.status === "not_connected" ||
            (access.status === "unavailable" && !access.blocked_domains.length),
        );
        if (available && globalFailure)
          return yield* Effect.fail(
            new ValidationError({ message: "Check results disagree about browser access." }),
          );
      }
      for (const route of routes.values()) {
        const preferred = route.find((item) => item.access.status === "available") ?? route[0];
        if (!preferred) continue;
        const access = preferred.access;
        const checkedDomains = route
          .filter((item) => item.access.status === "available")
          .flatMap((item) =>
            MARKETPLACES.filter((platform) => platform.id === item.marketplace).map(
              (platform) => new URL(platform.home).hostname,
            ),
          );
        const priorBlocks = candidate.browser_access
          .filter(
            (item) =>
              item.browser === access.browser &&
              item.browser_id === access.browser_id &&
              item.host === access.host &&
              item.profile === access.profile &&
              item.context_id === ACCESS_CONTEXT,
          )
          .flatMap((item) => item.blocked_domains)
          .filter(
            (blocked) =>
              !checkedDomains.some(
                (domain) => blocked === "*" || domain === blocked || domain.endsWith(`.${blocked}`),
              ),
          );
        const blocked = route.flatMap((item) => {
          const explicit = item.access.blocked_domains;
          if (item.access.status === "available" || explicit.length) return explicit;
          // Denied/unknown observations refer to this supplied site, not every site.
          if (item.access.status !== "denied" && item.access.status !== "unknown") return [];
          return MARKETPLACES.filter((platform) => platform.id === item.marketplace).map(
            (platform) => new URL(platform.home).hostname,
          );
        });
        candidate.browser_access = [
          ...candidate.browser_access.filter((item) => item.browser !== access.browser),
          {
            ...access,
            blocked_domains: [...new Set([...priorBlocks, ...blocked])],
            checked_at: now,
            context_id: ACCESS_CONTEXT,
          },
        ];
      }
      for (const { session } of observations) {
        if (session)
          candidate.platform_sessions = [
            ...candidate.platform_sessions.filter(
              (item) =>
                !(
                  item.marketplace === session.marketplace &&
                  item.browser === session.browser &&
                  item.browser_id === session.browser_id &&
                  item.host === session.host &&
                  item.profile === session.profile
                ),
            ),
            { ...session, checked_at: now, context_id: ACCESS_CONTEXT },
          ].slice(-100);
      }
    } else if (action === "report_browser_access") {
      const report = yield* validation(() => accessReportSchema.parse(args["report"]));
      candidate.browser_access = [
        ...candidate.browser_access.filter((item) => item.browser !== report.browser),
        { ...report, checked_at: now, context_id: ACCESS_CONTEXT },
      ];
    } else if (action === "report_listing_contact") {
      const report = yield* validation(() => listingContactReportSchema.parse(args["report"]));
      candidate.listing_contacts = [
        ...(candidate.listing_contacts ?? []).filter(
          (item) => !(item.listing_key === report.listing_key && item.browser === report.browser),
        ),
        { ...report, checked_at: now, context_id: ACCESS_CONTEXT },
      ].slice(-5000);
    } else {
      const report = yield* validation(() => sessionReportSchema.parse(args["report"]));
      candidate.platform_sessions = [
        ...candidate.platform_sessions.filter(
          (item) =>
            !(
              item.marketplace === report.marketplace &&
              item.browser === report.browser &&
              item.host === report.host &&
              item.profile === report.profile
            ),
        ),
        { ...report, checked_at: now, context_id: ACCESS_CONTEXT },
      ].slice(-100);
    }
  } else if (action === "record_listing_feedback") {
    const feedback = yield* validation(() => feedbackInputSchema.parse(args["feedback"]));
    const search = candidate.searches.find((item) => item.id === feedback.search_id);
    if (!search)
      return yield* Effect.fail(new MissingSearch({ message: "That search no longer exists" }));
    candidate.feedback.push({
      ...feedback,
      id: yield* Effect.sync(randomUUID),
      category: search.product,
      created_at: iso(yield* Clock.currentTimeMillis),
      undone: false,
    });
  } else if (action === "undo_listing_feedback") {
    const event = candidate.feedback.find((item) => item.id === args["feedback_id"]);
    if (!event)
      return yield* Effect.fail(new MissingSearch({ message: "That feedback no longer exists" }));
    event.undone = true;
  } else {
    const settings = yield* validation(() => settingsSchema.parse(args["settings"]));
    // A browser preference grants no permission. Checks and seller actions still
    // require observed access in the selected browser/profile.
    Object.assign(
      candidate,
      Object.fromEntries(
        Object.entries(settings).filter(
          ([key]) => !["interval_minutes", "quiet_hours"].includes(key),
        ),
      ),
    );
    if (settings.interval_minutes !== undefined)
      candidate.schedule.interval_minutes = settings.interval_minutes;
    if (settings.quiet_hours !== undefined) candidate.schedule.quiet_hours = settings.quiet_hours;
    if (settings.location !== undefined) {
      candidate.location = settings.location;
      if (settings.location) {
        candidate.origin =
          settings.location.display === "postal"
            ? (settings.location.postal_code ?? settings.location.area)
            : settings.location.area;
        candidate.origin_confirmed = true;
      } else candidate.origin_confirmed = false;
    } else if (settings.origin !== undefined) {
      candidate.origin_confirmed = true;
      candidate.location = null;
    }
  }
  return candidate;
});
