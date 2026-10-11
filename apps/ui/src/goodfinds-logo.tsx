import type { ComponentProps } from "react";
import goodfindsLogo from "../../../assets/logo.png?inline";
import { cn } from "@/lib/utils";

export function GoodfindsLogo({ className, ...props }: Omit<ComponentProps<"img">, "src">) {
  return (
    <img
      src={goodfindsLogo}
      alt=""
      width={36}
      height={36}
      className={cn(
        "size-9 shrink-0 rounded-lg bg-black object-contain ring-1 ring-white/10",
        className,
      )}
      {...props}
    />
  );
}
