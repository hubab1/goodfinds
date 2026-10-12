import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ResponsiveOverlay } from "@/components/ui/responsive-overlay";
import { previewWorkspaceReset, requestHostAction } from "@/lib/client";
import type { Action } from "@/lib/actions";
import type { WorkspaceResetPreview } from "@goodfinds/contracts/workspace-reset";
import { errorMessage } from "@goodfinds/contracts/state";

export function WorkspaceReset({
  mode,
  busy,
  action,
}: {
  mode: "live" | "sample";
  busy: boolean;
  action: Action;
}) {
  const [preview, setPreview] = useState<WorkspaceResetPreview>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const button = useRef<HTMLButtonElement>(null);
  const request = useRef(crypto.randomUUID());
  async function review() {
    setPending(true);
    setError("");
    setNotice("");
    try {
      setPreview(await previewWorkspaceReset(mode));
      request.current = crypto.randomUUID();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }
  async function remove() {
    if (!preview || pending || busy) return;
    setPending(true);
    setError("");
    try {
      if (!preview.ready) {
        await requestHostAction(
          `I confirm deleting all Goodfinds data in the ${mode} workspace, including settings, listing history, unsent drafts and cached media. Use preview_goodfinds_workspace_reset, stop its active runs, remove only its listed host schedules, preview again and use reset_goodfinds_workspace. Preserve browser sign-ins, plugin files, other workspaces and chats. Report the successful reset receipt and media cleanup status.`,
        );
        setPreview(undefined);
        setNotice("Reset requested in chat. Check the completion receipt there.");
      } else {
        const next = await action(
          "reset_goodfinds_workspace",
          {
            mode,
            request_id: request.current,
            reset_token: preview.reset_token,
            confirmation: "delete_all_goodfinds_data",
          },
          "Workspace data deleted.",
        );
        if (next) {
          setPreview(undefined);
          setNotice("Workspace data deleted.");
        }
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="space-y-3 border-t pt-4">
      <h3 className="font-medium">Workspace data</h3>
      <p className="text-sm text-muted-foreground">
        Review everything saved in this workspace before deleting it.
      </p>
      <Button
        ref={button}
        disabled={busy || pending}
        onClick={() => {
          void review();
        }}
      >
        Delete all workspace data…
      </Button>
      {notice && <output>{notice}</output>}
      {error && <p role="alert">{error}</p>}
      <ResponsiveOverlay
        open={!!preview}
        onOpenChange={(open) => {
          if (!open && !pending) setPreview(undefined);
        }}
        title="Delete all workspace data?"
        description="This permanently deletes the data below."
        returnFocus={button}
        footer={
          <>
            <Button disabled={pending} onClick={() => setPreview(undefined)}>
              Cancel
            </Button>
            <Button
              disabled={pending || busy}
              onClick={() => {
                void remove();
              }}
            >
              {pending ? "Deleting…" : "Delete all data"}
            </Button>
          </>
        }
      >
        {preview && (
          <div className="space-y-3 text-sm">
            <p>
              {preview.counts["saved_searches"] ?? 0} searches, {preview.counts["listings"] ?? 0}{" "}
              listings, {preview.counts["seller_conversations"] ?? 0} seller conversations and{" "}
              {preview.media_files} cached media files.
            </p>
            <p>{preview.scope}</p>
            {!preview.ready && (
              <p>
                {preview.active_run_ids.length} active runs and {preview.schedule_cleanup.length}{" "}
                linked schedules must stop first. The chat will complete that cleanup and deletion.
              </p>
            )}
            {error && <p role="alert">{error}</p>}
          </div>
        )}
      </ResponsiveOverlay>
    </section>
  );
}
