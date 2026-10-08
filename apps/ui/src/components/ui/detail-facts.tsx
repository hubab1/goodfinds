import type { ReactNode } from "react";
import "./detail-facts.css";

export type DetailFact = { id?: string; label: string; value: ReactNode };

/** Shared label/value alignment for listing facts, comparisons and costs. */
export function DetailFacts({ facts }: { facts: DetailFact[] }) {
  return (
    <dl className="detail-facts">
      {facts.map((fact) => (
        <div key={fact.id ?? fact.label} className="detail-fact">
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
