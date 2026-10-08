import "./listings.css";
import { Disclosure } from "@/components/ui/disclosure";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  ImageIcon,
  Images,
  Play,
  Info,
  UserRound,
  X,
} from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getSavedImage, getSavedVideo } from "@/lib/client";
import type { Listing } from "@goodfinds/contracts/state";
import { RelativeTime } from "@/relative-time";
import { marketplaceUrl } from "@/lib/presentation";
import {
  joinedLabel,
  listingCountIsFresh,
  listingCountLabel,
  sellerInventorySignal,
} from "@/lib/seller";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { photoBackdropLayout } from "@/lib/photo-background";
import type { PhotoBackdrop } from "@/lib/photo-background";

function SavedImage({
  id,
  alt,
  avatar = false,
  selected = true,
  className,
}: {
  id: string;
  alt: string;
  avatar?: boolean;
  selected?: boolean;
  className?: string;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState({ id, src: "", failed: false });
  const { src, failed } = loaded.id === id ? loaded : { src: "", failed: false };
  const [backdrop, setBackdrop] = useState<PhotoBackdrop>({ axis: "none", gap: 0 });
  useEffect(() => {
    const element = root.current;
    if (!element || avatar) return () => undefined;
    const update = ([entry]: ResizeObserverEntry[]) => {
      const photo = image.current;
      if (!photo || !entry) return;
      const next = photoBackdropLayout(
        photo.naturalWidth,
        photo.naturalHeight,
        entry.contentRect.width,
        entry.contentRect.height,
      );
      setBackdrop((current) =>
        current.axis === next.axis && current.gap === next.gap ? current : next,
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [avatar]);
  useEffect(() => {
    let active = true;
    let visible = false;
    let pending = false;
    const element = root.current;
    if (!element || !selected)
      return () => {
        active = false;
      };
    const observer = new IntersectionObserver(
      (entries) => {
        const next = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0);
        const entered = next && !visible;
        visible = next;
        if (!entered || pending) return;
        pending = true;
        void getSavedImage(id).then(
          (value) => {
            pending = false;
            if (active) setLoaded({ id, src: value, failed: false });
          },
          () => {
            pending = false;
            if (active) setLoaded({ id, src: "", failed: true });
          },
        );
      },
      { threshold: 0.01 },
    );
    observer.observe(element);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [id, selected]);
  const backdropStyle: CSSProperties & {
    "--photo-source": string;
    "--photo-gap": string;
  } = {
    "--photo-source": `url("${src}")`,
    "--photo-gap": `${backdrop.gap}px`,
  };
  return (
    <span
      ref={root}
      className={cn(
        avatar
          ? "flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted"
          : "relative isolate flex aspect-[4/3] max-h-80 items-center justify-center overflow-hidden rounded-lg bg-white",
        className,
      )}
    >
      {!avatar && src && backdrop.axis !== "none" && (
        <span
          aria-hidden="true"
          className="photo-edge-background"
          data-fill={backdrop.axis}
          style={backdropStyle}
        />
      )}
      {src ? (
        <img
          ref={image}
          src={src}
          alt={alt}
          className={avatar ? "size-full object-cover" : "relative z-10 size-full object-contain"}
          onLoad={(event) => {
            const element = root.current;
            if (!avatar && element) {
              const box = getComputedStyle(element);
              setBackdrop(
                photoBackdropLayout(
                  event.currentTarget.naturalWidth,
                  event.currentTarget.naturalHeight,
                  Number.parseFloat(box.width),
                  Number.parseFloat(box.height),
                ),
              );
            }
          }}
          onError={() => {
            setLoaded({ id, src: "", failed: true });
          }}
        />
      ) : (
        <span className="flex flex-col items-center gap-2 text-xs text-muted-foreground">
          {avatar ? <UserRound aria-hidden="true" /> : <ImageIcon aria-hidden="true" />}
          {!avatar && (failed ? "Photo unavailable" : "Loading photo…")}
        </span>
      )}
    </span>
  );
}

function galleryItems(listing: Listing) {
  return [
    ...listing.photos.map((photo) => ({ kind: "photo" as const, ...photo })),
    ...listing.videos.map((video) => ({ kind: "video" as const, ...video })),
  ];
}

function MediaSlides({ listing, index }: { listing: Listing; index: number }) {
  return (
    <span
      className="flex size-full transition-transform duration-300 ease-out motion-reduce:transition-none"
      style={{ transform: `translateX(-${index * 100}%)` }}
    >
      {galleryItems(listing).map((item, position) => (
        <span
          key={`${item.kind}-${item.position}-${item.media_id}`}
          className="relative block h-full w-full shrink-0"
          aria-hidden={position !== index}
        >
          {item.kind === "photo" || item.poster_media_id ? (
            <SavedImage
              id={item.kind === "photo" ? item.media_id : (item.poster_media_id ?? "")}
              selected={position === index}
              alt={item.caption || `${listing.title}, ${item.kind} ${item.position}`}
              className="h-full max-h-none w-full rounded-none"
            />
          ) : (
            <span className="flex size-full items-center justify-center bg-muted">
              <Play className="size-10" aria-hidden="true" />
            </span>
          )}
          {item.kind === "video" && (
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="flex size-12 items-center justify-center rounded-full bg-black text-white">
                <Play aria-hidden="true" />
              </span>
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

function SavedVideo({ id, caption }: { id: string; caption: string }) {
  const [src, setSrc] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function load() {
    setBusy(true);
    setFailed(false);
    try {
      const value = await getSavedVideo(id);
      if (active.current) setSrc(value);
    } catch {
      if (active.current) setFailed(true);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return src ? (
    // Seller clips do not include caption files. Do not fabricate a transcript.
    // oxlint-disable-next-line jsx-a11y/media-has-caption
    <video
      className="h-full w-full object-contain"
      src={src}
      controls
      playsInline
      preload="metadata"
      aria-label={caption || "Seller video"}
      onError={() => {
        setSrc("");
        setFailed(true);
      }}
    />
  ) : (
    <div className="flex size-full flex-col items-center justify-center gap-3">
      <Play className="size-8" aria-hidden="true" />
      {failed && <p className="text-xs">Video unavailable. Try again or open the listing.</p>}
      <Button
        disabled={busy}
        onClick={() => {
          void load();
        }}
      >
        {busy ? "Loading video…" : failed ? "Retry video" : "Load video"}
      </Button>
    </div>
  );
}

export function ListingThumbnail({
  listing,
  index,
  onIndexChange,
  onOpen,
}: {
  listing: Listing;
  index: number;
  onIndexChange: (index: number) => void;
  onOpen: () => void;
}) {
  const carousel = useRef<HTMLFieldSetElement>(null);
  const items = galleryItems(listing);
  const current = Math.min(index, Math.max(0, items.length - 1));
  useEffect(() => {
    const element = carousel.current;
    if (!element) return () => undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0)) return;
        observer.disconnect();
        const adjacent = galleryItems(listing).filter(
          (_, position) => Math.abs(position - current) <= 1,
        );
        void Promise.allSettled(
          adjacent.flatMap((item) => {
            const id = item.kind === "photo" ? item.media_id : item.poster_media_id;
            return id ? [getSavedImage(id)] : [];
          }),
        );
      },
      { threshold: 0.01 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [listing, current]);
  const label = listing.videos.length ? "media" : "photos";
  return (
    <fieldset
      ref={carousel}
      className="listing-photo-carousel group relative min-w-0 aspect-[4/3] overflow-hidden rounded-xl border bg-white"
      aria-roledescription="carousel"
      aria-label={`${label === "media" ? "Photos and videos" : "Photos"} of ${listing.title}`}
    >
      <button
        type="button"
        className="block size-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-label={`See ${label} of ${listing.title}`}
        onClick={onOpen}
      >
        {items.length ? (
          <MediaSlides listing={listing} index={current} />
        ) : (
          <span className="flex h-full min-h-40 flex-col items-center justify-center gap-3 text-sm">
            <ImageIcon className="size-8" aria-hidden="true" />
            No photo saved
          </span>
        )}
      </button>
      {items.length > 1 && (
        <>
          <Button
            size="icon-sm"
            className="listing-photo-arrow absolute top-1/2 left-2 -translate-y-1/2 rounded-full opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            aria-label={`Previous ${label === "media" ? "media" : "photo"} of ${listing.title}`}
            disabled={current === 0}
            onClick={() => onIndexChange(current - 1)}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            size="icon-sm"
            className="listing-photo-arrow absolute top-1/2 right-2 -translate-y-1/2 rounded-full opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            aria-label={`Next ${label === "media" ? "media" : "photo"} of ${listing.title}`}
            disabled={current === items.length - 1}
            onClick={() => onIndexChange(current + 1)}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </>
      )}
      {items.length > 0 && (
        <output
          className="pointer-events-none absolute right-2 bottom-2 flex items-center gap-1.5 rounded-md bg-black px-2 py-1 text-xs text-white"
          aria-live="polite"
        >
          {items[current]?.kind === "video" ? (
            <Play className="size-3.5" aria-hidden="true" />
          ) : (
            <Images className="size-3.5" aria-hidden="true" />
          )}
          <span aria-hidden="true">
            {current + 1} / {items.length}
          </span>
          <span className="sr-only">
            {items[current]?.kind === "video" ? "Video" : "Photo"} {current + 1} of {items.length}
          </span>
        </output>
      )}
    </fieldset>
  );
}

export function ListingPhotos({
  listing,
  initialIndex = 0,
}: {
  listing: Listing;
  initialIndex?: number;
}) {
  const items = galleryItems(listing);
  const [index, setIndex] = useState(Math.min(initialIndex, Math.max(0, items.length - 1)));
  const item = items[index] ?? items[0];
  if (!item)
    return (
      <figure className="w-full min-w-0" aria-label="Listing photos and videos">
        <div className="flex aspect-[4/3] max-h-80 flex-col items-center justify-center gap-2 rounded-lg border text-xs text-muted-foreground">
          <ImageIcon className="size-6" aria-hidden="true" />
          <p>No photos or videos saved yet.</p>
        </div>
      </figure>
    );
  return (
    <figure className="w-full min-w-0 space-y-3" aria-label="Listing photos and videos">
      <div className="aspect-[4/3] max-h-80 overflow-hidden rounded-lg border">
        {item.kind === "video" ? (
          <SavedVideo key={item.media_id} id={item.media_id} caption={item.caption} />
        ) : (
          <MediaSlides listing={listing} index={index} />
        )}
      </div>
      <div className="flex items-center justify-center gap-3">
        <Button
          variant="outline"
          size="icon"
          aria-label="Previous listing media"
          disabled={index === 0}
          onClick={() => setIndex(index - 1)}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <output className="min-w-24 text-center text-xs tabular-nums" aria-live="polite">
          {item.kind === "video" ? "Video" : "Photo"} · {index + 1} of {items.length}
        </output>
        <Button
          variant="outline"
          size="icon"
          aria-label="Next listing media"
          disabled={index >= items.length - 1}
          onClick={() => setIndex(index + 1)}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
      {item.caption && (
        <figcaption className="text-xs text-muted-foreground">{item.caption}</figcaption>
      )}
    </figure>
  );
}

const EMPTY_SIGNALS: string[] = [];

export function SellerDetails({
  listing,
  supportingSignals = EMPTY_SIGNALS,
  compact = false,
}: {
  listing: Listing;
  supportingSignals?: string[] | undefined;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const popup = useRef<HTMLDivElement>(null);
  const name = listing.seller_name || "Seller";
  const joined = listing.seller_account_joined_at
    ? joinedLabel(listing.seller_account_joined_at)
    : null;
  const joinedText = compact
    ? joined?.replace("Joined Facebook in ", "Joined ").replace("Joined Facebook ", "Joined ")
    : joined;
  const countText = listing.seller_listing_count == null ? null : listingCountLabel(listing);
  const inventorySignal = sellerInventorySignal(listing);
  const friends =
    listing.seller_friend_count_text ||
    (listing.seller_friend_count != null
      ? (listing.seller_friend_count_precision === "lower_bound"
          ? "At least "
          : listing.seller_friend_count_precision === "approximate"
            ? "About "
            : "") +
        listing.seller_friend_count.toLocaleString("en-GB") +
        " friends"
      : null);
  const profiles = [
    { label: "Marketplace profile", href: marketplaceUrl(listing.seller_profile_url) },
    { label: "Facebook profile", href: marketplaceUrl(listing.seller_public_profile_url) },
  ].filter((profile) => profile.href);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip open={preview && !open} onOpenChange={setPreview}>
        <TooltipTrigger
          render={<Popover.Trigger />}
          type="button"
          aria-label={"About " + name}
          className={cn(
            "flex w-full cursor-pointer items-center gap-3 rounded-lg bg-background text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
            compact ? "py-1" : "border p-3",
          )}
        >
          {listing.seller_avatar_media_id ? (
            <SavedImage
              key={listing.seller_avatar_media_id}
              id={listing.seller_avatar_media_id}
              alt={name + "'s profile photo"}
              avatar
              className={compact ? "size-9 border" : ""}
            />
          ) : (
            <span
              className={cn(
                "flex shrink-0 items-center justify-center rounded-full border bg-muted",
                compact ? "size-9" : "size-12",
              )}
            >
              <UserRound className={compact ? "size-4" : undefined} aria-hidden="true" />
            </span>
          )}
          <span className="min-w-0 flex-1 space-y-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
              <span>{name}</span>
              {inventorySignal && (
                <Badge variant="outline" className="text-[10px]">
                  {inventorySignal.label}
                </Badge>
              )}
            </span>
            {(joinedText || countText) && (
              <span className="block leading-relaxed">
                {[joinedText, countText].filter(Boolean).join(" · ")}
              </span>
            )}
          </span>
          <Info className="size-4 shrink-0" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent align="start" className="w-64 space-y-1">
          <p className="font-semibold">{name}</p>
          {joined && <p>{joined}</p>}
          {countText && <p>{countText}</p>}
          {inventorySignal && <p>{inventorySignal.label}</p>}
          <p className="pt-1">Select for seller details.</p>
        </TooltipContent>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          className="z-50"
        >
          <Popover.Popup
            ref={popup}
            initialFocus={popup}
            className="max-h-[var(--available-height)] w-80 max-w-[calc(100vw-2rem)] space-y-3 overflow-y-auto rounded-xl border bg-white p-4 text-xs leading-relaxed shadow-lg outline-none"
          >
            <div className="flex items-start justify-between gap-3">
              <Popover.Title className="text-sm font-semibold">{name}</Popover.Title>
              <Popover.Close
                className="flex size-7 shrink-0 items-center justify-center rounded-md bg-black text-white"
                aria-label="Close seller details"
              >
                <X className="size-4" aria-hidden="true" />
              </Popover.Close>
            </div>
            <div className="space-y-1">
              {joined && <p>{joined}</p>}
              {countText && <p>{countText}</p>}
              {friends && <p>{friends}</p>}
            </div>
            {inventorySignal && (
              <section className="space-y-2 border-t pt-3" aria-label="Seller activity evidence">
                <Badge variant="outline">{inventorySignal.label}</Badge>
                <p>{inventorySignal.detail}</p>
                {inventorySignal.listings.length > 0 && (
                  <Disclosure
                    title={<> Supporting listings ({inventorySignal.listings.length}) </>}
                  >
                    <div className="mt-2 space-y-2">
                      {inventorySignal.evidence && <p>{inventorySignal.evidence}</p>}
                      <ul className="list-disc space-y-1 pl-4">
                        {inventorySignal.listings.map((item) => (
                          <li key={item.listing_id}>
                            <a
                              className="underline"
                              href={marketplaceUrl(item.url)}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {item.title}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </Disclosure>
                )}
                <p>
                  Checked <RelativeTime value={inventorySignal.checkedAt} />. This is a suggestion
                  based on saved listings.
                </p>
              </section>
            )}
            {(listing.seller_profile_notes ||
              supportingSignals.length > 0 ||
              listing.seller_listing_count_text ||
              listing.seller_listings_checked_at ||
              listing.seller_profile_checked_at ||
              listing.seller_metadata_checked_at) && (
              <Disclosure title={<> More profile details </>}>
                <div className="mt-2 space-y-2">
                  {listing.seller_profile_notes && <p>{listing.seller_profile_notes}</p>}
                  {supportingSignals.map((signal) => (
                    <p key={signal}>{signal}</p>
                  ))}
                  {listing.seller_listing_count_text && (
                    <p>Marketplace shows: {listing.seller_listing_count_text}</p>
                  )}
                  {listing.seller_listings_checked_at && (
                    <p>
                      Listing count checked{" "}
                      <RelativeTime value={listing.seller_listings_checked_at} />
                    </p>
                  )}
                  {listing.seller_listing_count != null && !listingCountIsFresh(listing) && (
                    <p>This count needs updating before it can be used in filters.</p>
                  )}
                  {(listing.seller_profile_checked_at || listing.seller_metadata_checked_at) && (
                    <p>
                      Profile checked{" "}
                      <RelativeTime
                        value={
                          listing.seller_profile_checked_at || listing.seller_metadata_checked_at
                        }
                      />
                    </p>
                  )}
                </div>
              </Disclosure>
            )}
            {profiles.length > 0 && (
              <div className="flex flex-col items-start gap-2 border-t pt-3">
                {profiles.map((profile) => (
                  <a
                    key={profile.label}
                    href={profile.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 underline"
                  >
                    {profile.label}
                    <ArrowUpRight className="size-3.5" aria-hidden="true" />
                  </a>
                ))}
              </div>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
