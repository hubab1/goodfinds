import { useCallback, useState } from "react";
import { ArrowDown, Check, LoaderCircle, RefreshCw, Settings2, Sparkles } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SavedSearch } from "@goodfinds/contracts/state";
import type { SearchDraft } from "@goodfinds/contracts/search-definition";
import { SettingsForm } from "@/features/settings/settings-page";
import { SearchEditor } from "@/features/searches/search-editor";
import goodfindsLogo from "../../../assets/logo.png?inline";
import { useWorkspace } from "@/app/use-workspace";
import { Searches } from "@/features/searches/searches-page";
import { Deals } from "@/features/listings/listings-page";
import { Activity } from "@/app/activity-page";

type Editor = { search: SavedSearch | undefined; draft?: SearchDraft; revision: string };
export function GoodfindsApp() {
  const [view, setView] = useState("searches");
  const [editor, setEditor] = useState<Editor>();
  const [listingSelection, setListingSelection] = useState<{
    searchId: string;
    unseen: boolean;
    visit: number;
  }>();
  const showSample = useCallback(() => setView("deals"), []);
  const { state, busy, error, notice, mode, action, searchNow, recordSeen, clearError } =
    useWorkspace(showSample);
  if (!state)
    return (
      <div className="mx-auto max-w-xl p-8">
        <Card>
          <CardContent className="space-y-4 py-6">
            {error ? (
              <>
                <h1 className="text-xl font-semibold">Goodfinds couldn’t open</h1>
                <p className="text-sm text-muted-foreground">{error}</p>
                <Button
                  disabled={busy}
                  onClick={() => {
                    void action("get_goodfinds_workspace", {});
                  }}
                >
                  Try again
                </Button>
              </>
            ) : (
              <p className="flex items-center gap-3">
                <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
                Opening your saved searches…
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  const props = { state, busy, action };
  return (
    <div className="@container mx-auto max-w-5xl px-5 pb-6 @lg:px-8" aria-busy={busy}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b py-5">
        <button
          type="button"
          className="flex items-center gap-2.5 text-xl font-semibold tracking-tight"
          aria-label="Goodfinds home"
          onClick={(event) => {
            event.preventDefault();
            setView("searches");
          }}
        >
          <img
            src={goodfindsLogo}
            alt=""
            width={36}
            height={36}
            className="size-9 shrink-0 rounded-lg"
          />
          Goodfinds
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              void action(
                mode === "sample" ? "get_goodfinds_workspace" : "load_goodfinds_sample_workspace",
                {
                  mode: mode === "sample" ? "live" : "sample",
                },
              );
            }}
          >
            {mode === "sample" ? "My searches" : "Try sample data"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label="Reload saved results"
            title="Reload saved results"
            disabled={busy}
            onClick={() => {
              void action("get_goodfinds_workspace", {});
            }}
          >
            <RefreshCw className={busy ? "animate-spin" : ""} aria-hidden="true" />
            <span className="hidden @sm:inline">Reload</span>
          </Button>
        </div>
      </header>
      {mode === "sample" && (
        <Alert className="mt-5 border-primary/20 bg-secondary">
          <Sparkles aria-hidden="true" />
          <AlertTitle>Sample workspace</AlertTitle>
          <AlertDescription>
            Listings, sellers, prices and journeys are fictional. Edits apply only to this
            workspace.
            <Button
              size="sm"
              className="mt-1 w-fit"
              disabled={busy}
              onClick={() => {
                void action("get_goodfinds_workspace", { mode: "live" });
              }}
            >
              Exit sample
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {view === "searches" && state.searches.length === 0 && (
        <>
          <section className="relative overflow-hidden py-9 @lg:py-12">
            <div className="relative z-10">
              <h1 className="text-3xl font-semibold tracking-tight @lg:text-4xl">
                Good finds. Your terms.
              </h1>
              <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
                Save what you’re looking for. Compare asking prices.
                <br />
                Keep the promising finds in one place.
              </p>
            </div>
            <div
              className="absolute top-7 right-1 hidden size-32 rotate-[-8deg] items-center justify-center rounded-[2rem] border border-primary bg-background text-primary @2xl:flex"
              aria-hidden="true"
            >
              <ArrowDown className="size-10" />
              <span className="text-6xl font-medium">£</span>
            </div>
          </section>
        </>
      )}
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <output className="sr-only" aria-live="polite">
        {busy ? "Working…" : notice}
      </output>
      {notice && (
        <div className="mb-4 flex items-center gap-2 text-sm text-primary">
          <Check className="size-4" aria-hidden="true" />
          {notice}
        </div>
      )}
      <Tabs
        value={view}
        onValueChange={(value) => {
          if (typeof value === "string") setView(value);
        }}
        className="mt-5 gap-6"
      >
        <TabsList
          variant="line"
          className="w-full justify-start border-b"
          aria-label="Goodfinds sections"
        >
          <TabsTrigger value="searches">Searches</TabsTrigger>
          <TabsTrigger value="deals">
            Listings
            {state.counts.deals > 0 && (
              <Badge className="ml-1 px-1.5 py-0 text-[10px]" variant="secondary">
                {state.counts.deals}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="settings">
            <Settings2 className="hidden @md:block" aria-hidden="true" />
            Settings
          </TabsTrigger>
        </TabsList>
        <TabsContent value="searches">
          <Searches
            {...props}
            onListings={(searchId, unseen) => {
              setListingSelection((current) => ({
                searchId,
                unseen,
                visit: (current?.visit ?? 0) + 1,
              }));
              setView("deals");
            }}
            onSearch={(search) => {
              void searchNow(search);
            }}
            resume={(draft) => {
              clearError();
              setEditor({ search: undefined, draft, revision: state.revision });
            }}
            edit={(search) => {
              clearError();
              setEditor({ search, revision: state.revision });
            }}
          />
        </TabsContent>
        <TabsContent value="deals">
          <Deals
            key={`${mode}:${listingSelection?.visit ?? 0}`}
            {...props}
            selection={listingSelection}
            recordSeen={recordSeen}
          />
        </TabsContent>
        <TabsContent value="activity">
          <Activity {...props} />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsForm key={mode} {...props} />
        </TabsContent>
      </Tabs>
      {editor && (
        <SearchEditor
          search={editor.search}
          {...(editor.draft ? { draft: editor.draft } : {})}
          revision={editor.revision}
          busy={busy}
          error={error}
          action={action}
          removable={state.searches.length > 1}
          close={() => {
            setEditor(undefined);
          }}
        />
      )}
    </div>
  );
}
