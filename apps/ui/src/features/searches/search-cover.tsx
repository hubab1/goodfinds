import "./search-list.css";
import { useEffect, useRef, useState } from "react";
import { Coffee, House, Laptop, Monitor, Search } from "lucide-react";
import { getSavedImage } from "@/lib/client";
import type { SavedSearch } from "@goodfinds/contracts/state";
import { bundledSearchCoverFor } from "@goodfinds/contracts/search-cover-presets";

function CategoryIllustration({ product }: { product: string }) {
  const Icon =
    product === "macbook_pro"
      ? Laptop
      : product === "mac_mini" || product === "mac_pro"
        ? Monitor
        : product === "rental"
          ? House
          : product === "espresso_machine"
            ? Coffee
            : Search;
  return <Icon className="size-20 stroke-1" aria-hidden="true" />;
}

export function SearchCover({
  search,
  compact = false,
}: {
  search: SavedSearch;
  compact?: boolean;
}) {
  const root = useRef<HTMLElement>(null);
  const [savedImage, setSavedImage] = useState<{ id: string; src: string; attempt: number }>();
  const [failure, setFailure] = useState<{ id: string; attempt: number }>();
  const [retry, setRetry] = useState(0);
  const fallback = bundledSearchCoverFor(search);
  const mediaId = search.cover?.media_id ?? fallback?.media_id;
  const src = savedImage?.id === mediaId && savedImage?.attempt === retry ? savedImage.src : "";
  useEffect(() => {
    const element = root.current;
    let active = true;
    if (!element || !mediaId)
      return () => {
        active = false;
      };
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void getSavedImage(mediaId).then(
        (value) => {
          if (active) {
            setSavedImage({ id: mediaId, src: value, attempt: retry });
            setFailure(undefined);
          }
        },
        () => {
          if (active) setFailure({ id: mediaId, attempt: retry });
        },
      );
    });
    observer.observe(element);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [mediaId, retry]);

  const picture = src;
  const metadata = src ? (search.cover ?? fallback) : undefined;
  const sourceUrl = metadata && "source_url" in metadata ? metadata.source_url : undefined;
  const area = search.product === "rental" ? search.values["area"] : undefined;
  const label =
    metadata?.kind === "manufacturer"
      ? "Product photo"
      : metadata?.kind === "area"
        ? "Area reference"
        : metadata?.kind === "stock"
          ? "Representative photo"
          : metadata?.kind === "user"
            ? "Your image"
            : typeof area === "string"
              ? area
              : "Search illustration";

  const credit = `${metadata?.source_name ?? "Illustration"} · ${label}`;
  const cover = (
    <div
      className={
        compact ? "search-thumbnail" : "flex h-40 items-center justify-center bg-background p-3"
      }
      title={credit}
    >
      {picture ? (
        <img
          src={picture}
          alt={metadata?.alt ?? `${search.definition.title} search illustration`}
          className="max-h-full w-full max-w-72 object-contain grayscale"
          loading="lazy"
          decoding="async"
          onError={() => {
            setSavedImage(undefined);
            if (mediaId) setFailure({ id: mediaId, attempt: retry });
          }}
        />
      ) : (
        <CategoryIllustration product={search.product} />
      )}
    </div>
  );
  return (
    <figure ref={root} className={compact ? "search-cover-compact" : "space-y-2"}>
      {compact && sourceUrl ? (
        <a
          href={sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={credit}
          className="block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {cover}
        </a>
      ) : (
        cover
      )}
      {mediaId && failure?.id === mediaId && failure.attempt === retry && (
        <output className="block text-center text-xs">
          <span>Cover unavailable. </span>
          <button
            type="button"
            className="underline"
            onClick={() => {
              setRetry((value) => value + 1);
            }}
          >
            Retry cover
          </button>
        </output>
      )}
      <figcaption
        className={compact ? "sr-only" : "text-center text-[11px] leading-relaxed text-foreground"}
      >
        {sourceUrl && !compact ? (
          <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">
            {metadata?.source_name}
          </a>
        ) : (
          (metadata?.source_name ?? "Illustration")
        )}
        {" · "}
        {label}
      </figcaption>
    </figure>
  );
}
