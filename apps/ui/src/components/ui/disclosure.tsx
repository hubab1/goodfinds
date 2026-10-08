import { Accordion } from "@base-ui/react/accordion";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const OPEN = ["content"];
const CLOSED: string[] = [];

/** One consistent disclosure surface for settings, listing details and preferences. */
export function Disclosure({
  title,
  children,
  className,
  defaultOpen = false,
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
}) {
  return (
    <Accordion.Root
      defaultValue={defaultOpen ? OPEN : CLOSED}
      className={cn("rounded-xl border bg-white", className)}
    >
      <Accordion.Item value="content">
        <Accordion.Header>
          <Accordion.Trigger className="group flex min-h-12 w-full items-center justify-between gap-3 rounded-xl px-4 py-3 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="min-w-0">{title}</span>
            <ChevronDown
              className="size-4 shrink-0 transition-transform group-aria-expanded:rotate-180 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </Accordion.Trigger>
        </Accordion.Header>
        <Accordion.Panel className="space-y-3 border-t px-4 py-4">{children}</Accordion.Panel>
      </Accordion.Item>
    </Accordion.Root>
  );
}
