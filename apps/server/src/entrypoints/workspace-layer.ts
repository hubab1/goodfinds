import type { Database } from "bun:sqlite";
import { Layer } from "effect";
import { SearchRuns } from "../searches/runs.ts";
import { SellerConversations } from "../sellers/conversations.ts";
import { searchRunStorageLayer } from "../platform/search-runs-sqlite.ts";
import { sellerConversationStorageLayer } from "../platform/seller-conversations-sqlite.ts";
import { listingStorageLayer } from "../platform/listings-sqlite.ts";
import { WorkspaceRepository } from "../workspace/repository.ts";
import type { WorkspaceContext } from "../workspace/context.ts";
import {
  loadConfiguration,
  saveConfiguration,
  configurationRevisions,
} from "../platform/configuration-sqlite.ts";
import { HostSchedules } from "../searches/host-schedules.ts";
import { observeHostSchedules } from "../platform/host-schedules.ts";

// This composition root shares one transaction connection across both domain modules.
export const workspaceWorkflowLayer = (db: Database, context: WorkspaceContext) =>
  Layer.mergeAll(
    SearchRuns.layer.pipe(Layer.provide(searchRunStorageLayer(db))),
    SellerConversations.layer.pipe(Layer.provide(sellerConversationStorageLayer(db))),
    listingStorageLayer(db, context.databasePath),
    Layer.succeed(WorkspaceRepository, {
      ebayCredentialsConfigured: Boolean(
        process.env["GOODFINDS_EBAY_CLIENT_ID"] && process.env["GOODFINDS_EBAY_CLIENT_SECRET"],
      ),
      configuration: loadConfiguration(db, context.mode),
      revisions: configurationRevisions(db),
      saveConfiguration: (config) => saveConfiguration(db, config),
    }),
    Layer.succeed(HostSchedules, {
      observe: (records, now) =>
        observeHostSchedules(
          records,
          context.mode === "sample" ? null : context.automationsDirectory,
          now,
        ),
    }),
  );
