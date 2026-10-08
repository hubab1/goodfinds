import type { Database } from "bun:sqlite";
import { conversationSchema } from "@goodfinds/contracts/seller-conversation";
import { Effect, Layer } from "effect";
import { SellerConversationRepository } from "../sellers/repository.ts";
import { validation } from "../workspace/errors.ts";
import { parseJson } from "../workspace/model.ts";
import { all, execute, get } from "./sqlite.ts";

export const sellerConversationStorageLayer = (db: Database) =>
  Layer.succeed(SellerConversationRepository, {
    list: Effect.fnUntraced(function* () {
      const rows = yield* all<{ data: string }>(
        db,
        "SELECT document_json AS data FROM seller_conversations ORDER BY updated_at DESC",
      );
      return yield* validation(() =>
        rows.map((row) => conversationSchema.parse(parseJson<unknown>(row.data))),
      );
    }),
    find: Effect.fnUntraced(function* (listingKey: string) {
      const entry = yield* get<{ data: string }>(
        db,
        "SELECT document_json AS data FROM seller_conversations WHERE listing_key=?",
        listingKey,
      );
      return entry
        ? yield* validation(() => conversationSchema.parse(parseJson<unknown>(entry.data)))
        : undefined;
    }),
    save: (conversation) =>
      execute(
        db,
        "INSERT INTO seller_conversations(listing_key,document_json,updated_at) VALUES(?,?,?) ON CONFLICT(listing_key) DO UPDATE SET document_json=excluded.document_json,updated_at=excluded.updated_at",
        [conversation.listing_key, JSON.stringify(conversation), conversation.updated_at],
      ).pipe(Effect.asVoid),
  });
