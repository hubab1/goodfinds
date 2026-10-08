import { Store } from "lucide-react";
import facebookLogo from "../../../assets/marketplace-logos/facebook.png?inline";
import ebayLogo from "../../../assets/marketplace-logos/ebay.png?inline";
import vintedLogo from "../../../assets/marketplace-logos/vinted.png?inline";
import gumtreeLogo from "../../../assets/marketplace-logos/gumtree.png?inline";
import autotraderLogo from "../../../assets/marketplace-logos/autotrader.png?inline";
import craigslistLogo from "../../../assets/marketplace-logos/craigslist.png?inline";
import { cn } from "@/lib/utils";

const logos: Record<string, string> = {
  facebook_marketplace: facebookLogo,
  ebay: ebayLogo,
  vinted: vintedLogo,
  gumtree: gumtreeLogo,
  autotrader: autotraderLogo,
  craigslist: craigslistLogo,
};

export function MarketplaceLogo({
  source,
  className,
}: {
  source: string | undefined;
  className?: string;
}) {
  const logo = logos[source ?? "facebook_marketplace"];
  return logo ? (
    <img
      src={logo}
      alt=""
      width={24}
      height={24}
      className={cn("size-6 shrink-0 object-contain", className)}
    />
  ) : (
    <Store className={cn("size-6 shrink-0", className)} aria-hidden="true" />
  );
}
