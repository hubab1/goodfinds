// Run in a separate process so hook mocks cannot affect other panel tests.
import { mock } from "bun:test";
import assert from "node:assert/strict";
import * as React from "react";
import type { ReactElement } from "react";
import { feedbackInputSchema } from "@goodfinds/contracts/discovery";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { WorkspaceStore } from "../reference-server/src/platform/workspace-sqlite.ts";
import type { Action } from "../../apps/ui/src/lib/actions.ts";

const values: unknown[] = [];
let cursor = 0;
void mock.module("react", () => ({
  ...React,
  useState(initial: unknown) {
    const index = cursor++;
    if (!(index in values)) values[index] = initial;
    return [
      values[index],
      (value: unknown) => {
        values[index] = value;
      },
    ];
  },
  useRef(initial: unknown) {
    return { current: initial };
  },
  useId() {
    return "disregard-fixture";
  },
}));
const { ListingDisregard } =
  await import("../../apps/ui/src/features/listings/listing-disregard.tsx");
const { MenuItem } = await import("../../apps/ui/src/components/ui/menu.tsx");
const { ResponsiveOverlay } =
  await import("../../apps/ui/src/components/ui/responsive-overlay.tsx");
const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-disregard-ui-"));
type ControlProps = {
  children?: unknown;
  footer?: unknown;
  disabled?: boolean;
  onClick?: () => void;
  open?: boolean;
  title?: string;
  description?: string;
  onSubmit?: (event: { preventDefault: () => void }) => void;
};
function elements(node: unknown): ReactElement<ControlProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<ControlProps>(node)) return [];
  return [node, ...elements(node.props.children), ...elements(node.props.footer)];
}
function click(element: ReactElement<ControlProps>) {
  assert.ok(element.props.onClick);
  element.props.onClick();
}
try {
  const state = Effect.runSync(
    new WorkspaceStore(folder, "sample").request("load_sample_workspace"),
  ).state;
  const search = state.searches[0];
  const original = state.listings[0];
  assert.ok(search && original);
  const listing = { ...original, product: search.product, attributes: {}, evidence: {} };
  const writes: Record<string, unknown>[] = [];
  const action: Action = async (_name, args) => {
    writes.push(args ?? {});
    return undefined;
  };
  const render = () => {
    cursor = 0;
    return ListingDisregard({
      listing,
      state: { ...state, searches: [search] },
      action,
      busy: false,
    });
  };
  const menu = elements(render()).find(
    (el) => el.type === MenuItem && el.props.children === "Exclude this model from this search",
  );
  assert.ok(menu);
  assert.notEqual(
    menu.props.disabled,
    true,
    "Unknown-model exclusion must explain the blocker when clicked, rather than silently disabling the menu item",
  );
  click(menu);
  const overlay = elements(render()).find((el) => el.type === ResponsiveOverlay);
  assert.ok(overlay);
  assert.equal(overlay.props.open, true);
  assert.equal(overlay.props.title, "Model not confirmed");
  assert.match(String(overlay.props.description), /confirm.*model/i);
  assert.equal(
    writes.length,
    0,
    "Opening the explanation must not silently dismiss or ban anything",
  );
  const dismiss = elements(overlay).find(
    (el) => el.props.children === "Disregard this listing only",
  );
  assert.ok(dismiss);
  const form = elements(overlay).find((el) => el.type === "form");
  assert.ok(form?.props.onSubmit);
  form.props.onSubmit({ preventDefault() {} });
  assert.equal(writes.length, 1);
  const listingFeedback = feedbackInputSchema.parse(writes[0]?.["feedback"]);
  assert.equal(listingFeedback.exclude_model, undefined);
  assert.equal(listingFeedback.reason, "Not interested");

  values.length = 0;
  listing.attributes = { model: "Known model" };
  listing.evidence = { model: "Sold unit label: Known model" };
  const knownMenu = elements(render()).find(
    (el) => el.type === MenuItem && el.props.children === "Exclude this model from this search",
  );
  assert.ok(knownMenu);
  click(knownMenu);
  assert.equal(writes.length, 2);
  assert.equal(feedbackInputSchema.parse(writes[1]?.["feedback"]).exclude_model, true);
  process.stdout.write(
    "PASS: exclusion clicks explain unknown models and preserve feedback scope\n",
  );
} finally {
  rmSync(folder, { recursive: true, force: true });
}
