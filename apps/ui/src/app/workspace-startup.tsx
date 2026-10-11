import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GoodfindsLogo } from "@/goodfinds-logo";

export function WorkspaceStartup({
  error,
  busy,
  onRetry,
}: {
  error: string;
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <main className="grid min-h-dvh place-items-center px-6 py-10">
      <div className="flex w-full max-w-sm flex-col items-center text-center">
        <GoodfindsLogo width={64} height={64} className="size-16 rounded-2xl" />
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">
          {error ? "Goodfinds couldn’t open" : "Goodfinds"}
        </h1>
        {error ? (
          <>
            <p role="alert" className="mt-3 w-full text-sm break-words text-muted-foreground">
              {error}
            </p>
            <Button className="mt-6" disabled={busy} onClick={onRetry}>
              Try again
            </Button>
          </>
        ) : (
          <output
            aria-live="polite"
            className="mt-3 flex items-center justify-center gap-2.5 text-sm text-muted-foreground"
          >
            <LoaderCircle
              className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            Opening your searches…
          </output>
        )}
      </div>
    </main>
  );
}
