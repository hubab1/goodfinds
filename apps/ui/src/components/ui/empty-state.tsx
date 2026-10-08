import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { Card, CardContent } from "./card";

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="py-12 text-center">
      <CardContent className="flex flex-col items-center gap-3">
        <Search className="size-8 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-lg font-semibold">{title}</h3>
        {children}
      </CardContent>
    </Card>
  );
}
