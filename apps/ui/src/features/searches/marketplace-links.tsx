import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { MARKETPLACES, marketSearchUrl } from "@goodfinds/contracts/integrations";
import type { SavedSearch } from "@goodfinds/contracts/state";
import { queryPlan } from "@goodfinds/contracts/search-workflow";
import { useState } from "react";

export function MarketplaceLinks({ search, country }: { search: SavedSearch; country: string }) {
  const queries = [...new Set(queryPlan(search).map((query) => query.text))];
  const [selected, setSelected] = useState(queries[0] ?? search.name);
  const query = queries.includes(selected) ? selected : (queries[0] ?? search.name);
  return (
    <details className="rounded-lg border p-3 text-sm">
      <summary className="cursor-pointer">Open selected marketplaces</summary>
      <p className="mt-2 text-xs text-muted-foreground">
        These links open the website for browsing. They do not record a completed check or prove
        sign-in.
      </p>
      <label className="mt-3 block">
        Search terms
        <NativeSelect
          className="ml-2 rounded border p-1"
          value={query}
          onChange={(event) => setSelected(event.target.value)}
        >
          {queries.map((text) => (
            <NativeSelectOption key={text}>{text}</NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      <div className="mt-3 flex flex-wrap gap-3">
        {(search.marketplaces ?? ["facebook_marketplace"]).map((source) => (
          <a
            key={source}
            className="underline underline-offset-4"
            href={marketSearchUrl(source, query, country)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {MARKETPLACES.find((marketplace) => marketplace.id === source)?.name}
          </a>
        ))}
      </div>
    </details>
  );
}
