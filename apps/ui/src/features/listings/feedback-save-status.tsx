import { CircleAlert, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function FeedbackSaveStatus({
  pending,
  failed,
  storageError,
  retry,
}: {
  pending: number;
  failed: number;
  storageError: boolean;
  retry: () => void;
}) {
  if (!pending) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
      role={failed ? "alert" : "status"}
    >
      {failed ? (
        <CircleAlert className="size-3.5" aria-hidden="true" />
      ) : (
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
      )}
      <span>
        {failed
          ? `${failed} ${failed === 1 ? "change couldn’t" : "changes couldn’t"} save`
          : `Saving ${pending} ${pending === 1 ? "change" : "changes"}…`}
      </span>
      {failed > 0 && (
        <Button size="sm" variant="ghost" onClick={retry}>
          Retry
        </Button>
      )}
      {storageError && <span>Keep this panel open until changes save.</span>}
    </div>
  );
}
