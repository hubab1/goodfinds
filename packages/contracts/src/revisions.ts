import { z } from "zod";

export const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const revisionsSchema = z.object({
  settings: revisionSchema,
  evidence: revisionSchema,
  searches: z.record(z.string(), revisionSchema),
  drafts: z.record(z.string(), revisionSchema),
  monitoring: z.record(z.string(), revisionSchema),
  feedback: z.record(z.string(), revisionSchema),
  absent: revisionSchema,
});
export type Revisions = z.infer<typeof revisionsSchema>;
export type EntityTarget = {
  kind: "settings" | "evidence" | "searches" | "drafts" | "monitoring" | "feedback";
  id?: string | undefined;
};

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? z.record(z.string(), z.unknown()).parse(value) : {};
const id = (value: unknown) => (typeof value === "string" ? value : undefined);

export function entityTarget(
  action: string,
  args: Record<string, unknown>,
): EntityTarget | undefined {
  if (action === "save_search") return { kind: "searches", id: id(object(args["search"])["id"]) };
  if (["set_search_cover", "set_search_enabled", "remove_search"].includes(action))
    return { kind: "searches", id: id(args["search_id"]) };
  if (action === "save_search_draft")
    return { kind: "drafts", id: id(object(args["draft"])["id"]) };
  if (action === "discard_search_draft") return { kind: "drafts", id: id(args["draft_id"]) };
  if (action === "set_monitoring" || action === "report_host_schedule")
    return {
      kind: "monitoring",
      id: id(object(args[action === "set_monitoring" ? "monitoring" : "report"])["search_id"]),
    };
  if (action === "save_settings" || action === "report_dispatcher_schedule")
    return { kind: "settings" };
  if (action.startsWith("report_")) return { kind: "evidence" };
  if (action === "undo_listing_feedback") return { kind: "feedback", id: id(args["feedback_id"]) };
  if (action === "record_listing_feedback") return { kind: "feedback" };
  return undefined;
}

export function entityRevision(revisions: Revisions, target: EntityTarget) {
  if (target.kind === "settings" || target.kind === "evidence") return revisions[target.kind];
  return target.id ? (revisions[target.kind][target.id] ?? revisions.absent) : revisions.absent;
}
