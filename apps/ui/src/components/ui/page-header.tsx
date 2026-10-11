import type { ReactNode, Ref } from "react";

export function PageHeader({
  title,
  subtitle,
  actions,
  headingRef,
  headingTabIndex,
}: {
  title: string;
  subtitle: string;
  actions?: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
  headingTabIndex?: number;
}) {
  return (
    <header data-slot="page-header" className="flex flex-wrap items-center justify-between gap-4">
      <div className="min-w-0">
        <h1
          ref={headingRef}
          tabIndex={headingTabIndex}
          className="text-2xl font-semibold leading-tight tracking-tight outline-none"
        >
          {title}
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
