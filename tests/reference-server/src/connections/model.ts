import { z } from "zod";
import { connectionCheckRunSchema } from "@goodfinds/contracts/connection-checks";
export const recordSchema = connectionCheckRunSchema.extend({
  target_scope_hash: z.string(),
  owner_process_id: z.uuid(),
  lease_expires_at_ms: z.number(),
  input_marketplaces: z.array(z.string()).nullable(),
  completion_token: z.uuid().optional(),
  observations_hash: z.string().optional(),
});
export type CheckRecord = z.infer<typeof recordSchema>;
