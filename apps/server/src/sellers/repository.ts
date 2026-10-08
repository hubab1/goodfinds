import type { Conversation } from "@goodfinds/contracts/seller-conversation";
import { Context } from "effect";
import type { Effect } from "effect";
import type { GoodfindsError, StorageError } from "../workspace/errors.ts";

export interface SellerConversationStorage {
  readonly list: () => Effect.Effect<Conversation[], GoodfindsError>;
  readonly find: (listingKey: string) => Effect.Effect<Conversation | undefined, GoodfindsError>;
  readonly save: (conversation: Conversation) => Effect.Effect<void, StorageError>;
}

export class SellerConversationRepository extends Context.Service<
  SellerConversationRepository,
  SellerConversationStorage
>()("goodfinds/SellerConversationRepository") {}
