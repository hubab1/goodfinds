import "./listings.css";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, Settings2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectControl } from "@/components/ui/select";
import { ResponsiveOverlay } from "@/components/ui/responsive-overlay";
import {
  EMPTY_SELLER_FILTERS,
  normalizeListingLimit,
  sellerFilterChips,
  sellerFilterCount,
  sellerFilterError,
} from "@/lib/seller";
import type { SellerFilters } from "@/lib/seller";
import type { SavedSearch } from "@goodfinds/contracts/state";
import { listingQuerySchema } from "@goodfinds/contracts/listing-query";
import type { ListingQuery } from "@goodfinds/contracts/listing-query";

const SORT_OPTIONS = [
  { value: "recommended", label: "Recommended" },
  { value: "price_low", label: "Price: low to high" },
  { value: "price_high", label: "Price: high to low" },
  { value: "found_newest", label: "Date found: newest first" },
  { value: "found_oldest", label: "Date found: oldest first" },
];

function FilterFields({
  filters,
  onChange,
}: {
  filters: SellerFilters;
  onChange: (filters: SellerFilters) => void;
}) {
  const id = useId();
  const error = sellerFilterError(filters);
  const [currentYear] = useState(() => new Date().getFullYear());
  const years = useMemo(
    () => [
      { value: "", label: "Any year" },
      ...Array.from({ length: currentYear - 1899 }, (_, index) => ({
        value: String(currentYear - index),
        label: String(currentYear - index),
      })),
    ],
    [currentYear],
  );
  const update = (field: keyof SellerFilters, value: string) =>
    onChange({ ...filters, [field]: value });
  return (
    <div className="space-y-4">
      <div className="grid gap-5 @xl:grid-cols-[1.4fr_1fr]">
        <fieldset className="min-w-0 space-y-3">
          <legend className="text-sm font-medium">Current listings</legend>
          <div className="grid grid-cols-2 gap-3">
            {(["minimumListings", "maximumListings"] as const).map((field) => (
              <div key={field} className="min-w-0 space-y-2">
                <Label htmlFor={id + "-" + field}>
                  {field === "minimumListings" ? "Minimum" : "Maximum"}
                </Label>
                <div className="relative">
                  <Input
                    id={id + "-" + field}
                    type="number"
                    min={0}
                    step={1}
                    placeholder="Any"
                    value={filters[field]}
                    className={filters[field] ? "pr-14" : ""}
                    aria-invalid={Boolean(error)}
                    onChange={(event) =>
                      update(field, normalizeListingLimit(event.currentTarget.value))
                    }
                  />
                  {filters[field] && (
                    <button
                      type="button"
                      className="filter-field-clear"
                      aria-label={
                        "Clear " +
                        (field === "minimumListings" ? "minimum" : "maximum") +
                        " listings"
                      }
                      onClick={() => update(field, "")}
                    >
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </fieldset>
        <div className="min-w-0 space-y-3">
          <Label htmlFor={id + "-year"} className="text-sm font-medium">
            Joined by
          </Label>
          <SelectControl
            id={id + "-year"}
            value={filters.joinedBy}
            onValueChange={(value) => update("joinedBy", value)}
            options={years}
          />
          <p className="text-xs leading-relaxed">Account joined in this year or earlier.</p>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-xs">
          {error}
        </p>
      ) : sellerFilterCount(filters) > 0 ? (
        <p className="text-xs leading-relaxed">
          Sellers with missing or outdated details are excluded.
        </p>
      ) : null}
    </div>
  );
}

export function ListingFilters({
  searches,
  search,
  onSearchChange,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  resultCount,
}: {
  searches: SavedSearch[];
  search: string;
  onSearchChange: (search: string) => void;
  filters: SellerFilters;
  onFiltersChange: (filters: SellerFilters) => void;
  sort: ListingQuery["sort"];
  onSortChange: (sort: ListingQuery["sort"]) => void;
  resultCount: number;
}) {
  const [open, setOpen] = useState(false);
  const searchOptions = useMemo(
    () => [
      { value: "all", label: "All searches" },
      ...searches.map((item) => ({ value: item.id, label: item.name })),
    ],
    [searches],
  );
  const [compact, setCompact] = useState(() => window.innerWidth < 640);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const id = useId();
  const active = sellerFilterCount(filters);
  const chips = sellerFilterChips(filters);
  useEffect(() => {
    const element = root.current;
    if (!element) return () => undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setCompact(entry.contentRect.width < 640);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const clear = () => onFiltersChange(EMPTY_SELLER_FILTERS);
  return (
    <div ref={root} className="space-y-3">
      <div className="grid grid-cols-1 items-end gap-3 min-[420px]:grid-cols-2 @xl:grid-cols-[minmax(0,14rem)_minmax(0,14rem)_auto]">
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor={id + "-search"} className="text-xs">
            Search
          </Label>
          <SelectControl
            id={id + "-search"}
            value={search}
            onValueChange={onSearchChange}
            options={searchOptions}
          />
        </div>
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor={id + "-sort"} className="text-xs">
            Sort by
          </Label>
          <SelectControl
            id={id + "-sort"}
            value={sort}
            onValueChange={(value) => onSortChange(listingQuerySchema.shape.sort.parse(value))}
            options={SORT_OPTIONS}
          />
        </div>
        <Button
          ref={trigger}
          className="justify-self-start min-[420px]:col-span-2 @xl:col-span-1 @xl:justify-self-end"
          aria-expanded={open}
          aria-controls={open ? id + "-panel" : undefined}
          onClick={() => setOpen((previous) => !previous)}
        >
          <Settings2 aria-hidden="true" />
          Seller filters
          {active > 0 && <Badge className="border-white/50 px-1.5 py-0">{active}</Badge>}
          {!compact && (
            <ChevronDown
              className={open ? "rotate-180 transition-transform" : "transition-transform"}
              aria-hidden="true"
            />
          )}
        </Button>
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" aria-label="Applied seller filters">
          {chips.map((chip) => (
            <Button
              key={chip.field}
              size="sm"
              aria-label={"Remove " + chip.label + " filter"}
              onClick={() => onFiltersChange({ ...filters, [chip.field]: "" })}
            >
              {chip.label}
              <X className="size-3" aria-hidden="true" />
            </Button>
          ))}
          <Button variant="link" size="sm" onClick={clear}>
            Clear all
          </Button>
        </div>
      )}
      {open && !compact && (
        <section
          id={id + "-panel"}
          aria-label="Seller filters"
          className="seller-filter-panel rounded-xl border bg-white p-5"
        >
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="font-semibold">Seller filters</h2>
            <Button size="sm" disabled={active === 0} onClick={clear}>
              Clear filters
            </Button>
          </div>
          <FilterFields filters={filters} onChange={onFiltersChange} />
        </section>
      )}
      <ResponsiveOverlay
        open={open && compact}
        onOpenChange={setOpen}
        returnFocus={trigger}
        title="Seller filters"
        footer={
          <>
            <Button disabled={active === 0} onClick={clear}>
              Clear filters
            </Button>
            <Button
              type="submit"
              form={id + "-form"}
              disabled={Boolean(sellerFilterError(filters))}
            >
              Show {resultCount} {resultCount === 1 ? "listing" : "listings"}
            </Button>
          </>
        }
      >
        <form
          id={id + "-form"}
          className="@container"
          onSubmit={(event) => {
            event.preventDefault();
            if (!sellerFilterError(filters)) setOpen(false);
          }}
        >
          <FilterFields filters={filters} onChange={onFiltersChange} />
        </form>
      </ResponsiveOverlay>
    </div>
  );
}
