import { useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { sourceName } from "@/lib/presentation";
import { MarketplaceLogo } from "@/marketplace-logo";

export function MarketplaceBadge({ source }: { source: string | undefined }) {
  const [open, setOpen] = useState(false);
  const name = sourceName(source);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        type="button"
        aria-label={name}
        closeOnClick={false}
        onClick={() => setOpen((previous) => !previous)}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border bg-white text-black outline-none focus-visible:ring-2 focus-visible:ring-black"
      >
        <MarketplaceLogo source={source} className="size-4" />
      </TooltipTrigger>
      <TooltipContent className="w-auto px-3 py-2">{name}</TooltipContent>
    </Tooltip>
  );
}
