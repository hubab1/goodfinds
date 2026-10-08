import type { GoodfindsState } from "@goodfinds/contracts/state";
import type { Action } from "@/lib/actions";

export type ViewProps = { state: GoodfindsState; busy: boolean; action: Action };
