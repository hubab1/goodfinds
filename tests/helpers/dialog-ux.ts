// Isolate the DOM fixture from server-rendered panel tests and their hook mocks.
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { WorkspaceStore } from "../reference-server/src/platform/workspace-sqlite.ts";
import type { Action } from "../../apps/ui/src/lib/actions.ts";

const dom = new Window({ url: "https://panel.example", width: 1200 });
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "Element",
  "Node",
  "MutationObserver",
  "ResizeObserver",
  "Event",
  "KeyboardEvent",
  "FocusEvent",
  "PointerEvent",
  "MouseEvent",
  "SVGElement",
]) {
  Object.defineProperty(globalThis, key, {
    value: key === "window" ? dom : Reflect.get(dom, key),
    configurable: true,
    writable: true,
  });
}
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) {
  Object.defineProperty(globalThis, key, { value: dom[key].bind(dom), configurable: true });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
Object.defineProperty(globalThis, "IntersectionObserver", {
  value: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  configurable: true,
});
const { createElement: el, act, useRef, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle, DialogTrigger } =
  await import("../../apps/ui/src/components/ui/dialog.tsx");
const { ResponsiveOverlay } =
  await import("../../apps/ui/src/components/ui/responsive-overlay.tsx");
const { Button } = await import("../../apps/ui/src/components/ui/button.tsx");
const { Menu, MenuTrigger, MenuContent, MenuItem } =
  await import("../../apps/ui/src/components/ui/menu.tsx");
const { FormField } = await import("../../apps/ui/src/components/ui/form-field.tsx");
const { Input } = await import("../../apps/ui/src/components/ui/input.tsx");
const { NativeSelect, NativeSelectOption } =
  await import("../../apps/ui/src/components/ui/native-select.tsx");
const { Textarea } = await import("../../apps/ui/src/components/ui/textarea.tsx");
const { SearchListRow } = await import("../../apps/ui/src/features/searches/search-list-row.tsx");
const { monitoringSummary } = await import("@goodfinds/contracts/monitoring");
import type { MonitoringSummary } from "@goodfinds/contracts/monitoring";
const { SelectControl } = await import("../../apps/ui/src/components/ui/select.tsx");
const { Disclosure } = await import("../../apps/ui/src/components/ui/disclosure.tsx");
const { SearchEditor } = await import("../../apps/ui/src/features/searches/search-editor.tsx");
const { ListingDisregard } =
  await import("../../apps/ui/src/features/listings/listing-disregard.tsx");
const { SellerConversationPanel } =
  await import("../../apps/ui/src/features/conversations/seller-conversation-panel.tsx");
const { ListingDetail } = await import("../../apps/ui/src/features/listings/listing-card.tsx");

function required(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  assert.ok(found, `Missing ${selector}`);
  return found;
}
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label || item.getAttribute("aria-label") === label,
  );
  assert.ok(found, `Missing button: ${label}`);
  return found;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function escape() {
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
}
function ResponsiveFixture() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return el(
    "div",
    null,
    el(Button, { ref: trigger, onClick: () => setOpen(true) }, "Change"),
    el(ResponsiveOverlay, {
      open,
      onOpenChange: setOpen,
      returnFocus: trigger,
      title: "Edit details",
      footer: el(Button, { type: "submit", form: "responsive-form" }, "Save"),
      children: el(
        "form",
        {
          id: "responsive-form",
          onSubmit: (event) => {
            event.preventDefault();
            setOpen(false);
          },
        },
        el("input", { id: "responsive-field", required: true, defaultValue: "Value" }),
        el("textarea", { id: "multiline" }),
      ),
    }),
  );
}
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-dialog-ux-"));
try {
  function FieldsFixture({ error }: { error?: string }) {
    return el(
      "form",
      null,
      el(FormField, {
        id: "buyer-name",
        label: "Name",
        hint: "Your preferred name",
        error,
        children: el(Input, { defaultValue: "Buyer" }),
      }),
      el(FormField, {
        id: "buyer-source",
        label: "Source",
        hint: "Choose a marketplace",
        children: el(NativeSelect, null, el(NativeSelectOption, { value: "ebay" }, "eBay")),
      }),
      el(FormField, {
        id: "buyer-notes",
        label: "Notes",
        hint: "Optional details",
        children: el(Textarea, { defaultValue: "Details" }),
      }),
    );
  }
  await act(async () => root.render(el(FieldsFixture, { error: "Check this name" })));
  const nameInput = required("#buyer-name");
  assert.equal(nameInput.getAttribute("aria-invalid"), "true");
  assert.equal(nameInput.getAttribute("aria-describedby"), "buyer-name-hint buyer-name-error");
  for (const id of ["buyer-name", "buyer-source", "buyer-notes"]) {
    assert.ok(document.querySelector(`label[for="${id}"]`));
    const references = required(`#${id}`).getAttribute("aria-describedby")?.split(" ") ?? [];
    assert.ok(references.length);
    for (const reference of references) assert.ok(document.getElementById(reference));
  }
  await act(async () => root.render(el(FieldsFixture)));
  assert.equal(nameInput.getAttribute("aria-invalid"), "false");
  assert.equal(nameInput.getAttribute("aria-describedby"), "buyer-name-hint");
  assert.equal(document.querySelector("#buyer-name-error"), null);
  assert.ok(nameInput instanceof HTMLInputElement);
  assert.equal(nameInput.value, "Buyer", "Updating field errors preserves entered text");
  const selections: string[] = [];
  await act(async () =>
    root.render(
      el(
        Dialog,
        { defaultOpen: true },
        el(
          DialogContent,
          null,
          el(DialogHeader, null, el(DialogTitle, null, "Controls")),
          el(
            DialogBody,
            null,
            el("label", { htmlFor: "fixture-sort" }, "Sort by"),
            el(SelectControl, {
              id: "fixture-sort",
              value: "price",
              onValueChange: (value) => selections.push(value),
              options: [
                { value: "price", label: "Price" },
                { value: "date", label: "Date found" },
              ],
            }),
            el(Disclosure, { title: "Your preferences", children: el("p", null, "Saved choices") }),
          ),
        ),
      ),
    ),
  );
  await act(async () => required("#fixture-sort").click());
  assert.ok(document.querySelector("[role=listbox]"));
  await escape();
  assert.equal(document.querySelector("[role=listbox]"), null, "Escape closes only the select");
  assert.ok(document.querySelector("[role=dialog]"));
  assert.equal(document.activeElement?.id, "fixture-sort");
  await act(async () => required("#fixture-sort").click());
  const dateOption = [...document.querySelectorAll<HTMLElement>("[role=option]")].find(
    (item) => item.textContent === "Date found",
  );
  assert.ok(dateOption);
  await act(async () => dateOption.click());
  assert.deepEqual(selections, ["date"], "Dropdown selection calls the controlled action once");
  await act(async () => required("#fixture-sort").click());
  await act(async () =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    ),
  );
  await act(async () =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  assert.deepEqual(selections, ["date", "date"], "Arrow keys and Enter choose an option");
  assert.ok(
    document.querySelector("[role=dialog]"),
    "Selecting an option does not submit or close the dialog",
  );
  await click("Your preferences");
  assert.equal(button("Your preferences").getAttribute("aria-expanded"), "true");
  assert.ok(document.body.textContent?.includes("Saved choices"));
  await click("Your preferences");
  assert.equal(button("Your preferences").getAttribute("aria-expanded"), "false");
  await escape();
  assert.equal(document.querySelector("[role=dialog]"), null);
  // Base UI handles Escape at the current layer, traps focus and restores it to the trigger.
  await act(async () =>
    root.render(
      el(
        Dialog,
        null,
        el(DialogTrigger, null, "Open"),
        el(
          DialogContent,
          null,
          el(DialogHeader, null, el(DialogTitle, null, "Details")),
          el(
            DialogBody,
            null,
            el("input", { id: "first-field" }),
            el(
              Menu,
              null,
              el(MenuTrigger, null, "Options"),
              el(MenuContent, null, el(MenuItem, null, "Choice")),
            ),
          ),
        ),
      ),
    ),
  );
  await click("Open");
  assert.equal(document.activeElement?.id, "first-field");
  await click("Options");
  assert.ok(document.querySelector("[role=menu]"));
  await escape();
  assert.ok(
    document.querySelector("[role=dialog]"),
    "Escape closes a nested menu before its dialog",
  );
  assert.equal(document.querySelector("[role=menu]"), null);
  await escape();
  assert.equal(document.querySelector("[role=dialog]"), null);
  assert.equal(document.activeElement?.textContent, "Open");

  await act(async () => root.render(el(ResponsiveFixture)));
  await click("Change");
  assert.equal(document.activeElement?.id, "responsive-field");
  const save = button("Save");
  assert.equal(save.type, "submit");
  assert.equal(save.form?.id, "responsive-form", "Footer actions submit the body form");
  const field = required("#responsive-field");
  assert.ok(field instanceof HTMLInputElement);
  field.value = "";
  await act(async () => save.form?.requestSubmit(save));
  assert.ok(document.querySelector("[role=dialog]"), "Invalid required fields prevent submission");
  field.value = "Value";
  const textarea = required("#multiline");
  assert.ok(textarea instanceof HTMLTextAreaElement);
  await act(async () => {
    textarea.focus();
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  assert.ok(document.querySelector("[role=dialog]"), "Enter in a textarea never submits");
  await act(async () => save.form?.requestSubmit(save));
  assert.equal(document.querySelector("[role=dialog]"), null);
  assert.equal(document.activeElement?.textContent, "Change");

  // Exercise the actual mobile sheet with the same form and return-focus contract.
  await act(async () => dom.happyDOM.setViewport({ width: 375, height: 800 }));
  await click("Change");
  const sheet = required("[role=dialog]");
  assert.ok(sheet.classList.contains("responsive-overlay-sheet"));
  assert.equal(document.activeElement, sheet, "Mobile opening does not summon the keyboard");
  await escape();
  assert.equal(document.querySelector("[role=dialog]"), null);
  assert.equal(document.activeElement?.textContent, "Change");
  await act(async () => dom.happyDOM.setViewport({ width: 1200, height: 800 }));

  const state = Effect.runSync(
    new WorkspaceStore(folder, "sample").request("load_sample_workspace"),
  ).state;
  const search = state.searches[0];
  const listing = state.listings.find((item) => item.product === search?.product);
  assert.ok(search && listing);
  let edits = 0;
  const activeSearch = { ...search, enabled: true };
  const unscheduled = monitoringSummary(activeSearch, [], 60, false, false);
  const renderSearchRow = async (monitoring: MonitoringSummary) => {
    await act(async () =>
      root.render(
        el(
          "ul",
          null,
          el(SearchListRow, {
            search: activeSearch,
            origin: state.config.origin,
            sample: false,
            revision: state.revision,
            busy: false,
            action: async () => undefined,
            edit: () => {
              edits += 1;
            },
            onSearch: () => undefined,
            monitoring,
          }),
        ),
      ),
    );
  };
  await renderSearchRow(unscheduled);
  await click(`More options for ${search.name}`);
  assert.ok(required("[role=menu]").textContent?.includes("Keep watching"));
  await escape();
  assert.equal(document.querySelector("[role=menu]"), null);
  assert.equal(document.activeElement, button(`More options for ${search.name}`));
  await click(`More options for ${search.name}`);
  const editItem = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find(
    (item) => item.textContent?.trim() === "Edit search",
  );
  assert.ok(editItem);
  await act(async () => {
    editItem.focus();
    editItem.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  assert.equal(edits, 1, "Keyboard menu selection dispatches the feature action exactly once");
  assert.equal(document.querySelector("[role=menu]"), null);
  await renderSearchRow({
    ...unscheduled,
    status: "paused",
    preference: "recurring",
    next_action: "resume",
  });
  await click(`More options for ${search.name}`);
  assert.ok(required("[role=menu]").textContent?.includes("Resume monitoring"));
  assert.equal(required("[role=menu]").textContent?.includes("Pause search"), false);
  await escape();
  // Test the actual read-only detail dialog with isolated media; no browser or live listings.
  let preparedFrom: HTMLElement | undefined;
  const detailListing = {
    ...listing,
    url: "https://www.facebook.com/marketplace/item/1234567890001/",
    photos: [
      { media_id: "fixture-photo-a", position: 1, caption: "Front" },
      { media_id: "fixture-photo-b", position: 2, caption: "Back" },
    ],
    videos: [],
    seller_avatar_media_id: null,
    description: "A description long enough to remain in the scrollable body.",
  };
  await act(async () =>
    root.render(
      el(
        Dialog,
        null,
        el(DialogTrigger, null, "Listing details"),
        el(ListingDetail, {
          listing: detailListing,
          decisions: [],
          searches: [search],
          sample: false,
          photoIndex: 0,
          onNegotiate: (element) => {
            preparedFrom = element;
          },
        }),
      ),
    ),
  );
  await click("Listing details");
  const detail = required("[role=dialog]");
  assert.equal(
    document.activeElement,
    detail,
    "Read-only details focus the dialog rather than an action",
  );
  const footer = required("[data-slot=dialog-footer]");
  assert.ok(
    footer.contains(button("Prepare message")),
    "The message action stays outside the scrolling body",
  );
  assert.ok(footer.querySelector("a[href]"), "The original listing link is in the same footer");
  await click("Next listing media");
  assert.ok(detail.textContent?.includes("Photo · 2 of 2"));
  assert.equal(button("Next listing media").disabled, true);
  await click("Previous listing media");
  assert.ok(detail.textContent?.includes("Photo · 1 of 2"));
  await click("Prepare message");
  assert.equal(preparedFrom, button("Prepare message"));
  await click("Listing history");
  assert.equal(button("Listing history").getAttribute("aria-expanded"), "true");
  await escape();
  assert.equal(document.querySelector("[role=dialog]"), null);
  assert.equal(document.activeElement?.textContent, "Listing details");
  const writes: string[] = [];
  let finish: (() => void) | undefined;
  const action: Action = async (name) => {
    writes.push(name);
    await new Promise<void>((resolveAction) => {
      finish = resolveAction;
    });
    return state;
  };
  let closed = 0;
  await act(async () =>
    root.render(
      el(SearchEditor, {
        search,
        revision: state.revision,
        busy: false,
        error: "",
        removable: true,
        action,
        close: () => {
          closed += 1;
        },
      }),
    ),
  );
  assert.equal(button("Cancel").type, "button");
  const reviewForm = button("Review search").form;
  assert.ok(reviewForm);
  // Happy DOM's floating-point modulo rejects valid fractional currency steps.
  // Validate answers through the actual search schema; native required validation
  // is exercised separately in the responsive form fixture.
  reviewForm.noValidate = true;
  await act(async () => reviewForm.requestSubmit());
  assert.ok(button("Save search"));
  assert.equal(document.activeElement?.textContent, "Review your search");
  assert.equal(writes.length, 0, "Review is separate from saving");
  await act(async () => {
    const form = button("Save search").form;
    assert.ok(form);
    form.requestSubmit();
    form.requestSubmit();
  });
  assert.deepEqual(writes, ["save_goodfinds_search"], "Repeated submissions save once");
  await escape();
  assert.equal(closed, 1, "Escape remains available while a save is finishing");
  assert.ok(finish);
  await act(async () => finish?.());
  assert.equal(closed, 1, "A completed save never closes a later dialog after Escape");

  await act(async () =>
    root.render(
      el(ListingDisregard, {
        listing,
        state: { ...state, searches: [search] },
        busy: false,
        action: async (name) => {
          writes.push(name);
          return undefined;
        },
      }),
    ),
  );
  await click("Choose a reason to disregard");
  const other = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find(
    (node) => node.textContent === "Other reason…",
  );
  assert.ok(other);
  await act(async () => other.click());
  assert.equal(button("Disregard").type, "button");
  const submit = [...document.querySelectorAll<HTMLButtonElement>("[role=dialog] button")].find(
    (item) => item.type === "submit",
  );
  assert.ok(submit?.form);
  await act(async () => submit.form?.requestSubmit(submit));
  assert.equal(writes.at(-1), "record_goodfinds_listing_feedback");
  await escape();
  assert.equal(document.querySelector("[role=dialog]"), null);

  // Saving from the message form must not turn Enter into a seller send action.
  const conversationWrites: string[] = [];
  const conversationAction: Action = async (name) => {
    conversationWrites.push(name);
    const response = Effect.runSync(
      new WorkspaceStore(folder, "sample").request("get_seller_conversation", {
        listing_key: listing.key,
      }),
    ).state;
    return response;
  };
  await act(async () =>
    root.render(
      el(SellerConversationPanel, {
        listing,
        state,
        busy: false,
        returnFocus: { current: null },
        open: true,
        onOpenChange: () => undefined,
        action: conversationAction,
      }),
    ),
  );
  const draftSubmit = button("Save draft");
  assert.equal(draftSubmit.type, "submit");
  assert.ok(draftSubmit.form);
  draftSubmit.form.noValidate = true;
  await act(async () => draftSubmit.form?.requestSubmit(draftSubmit));
  assert.ok(conversationWrites.includes("save_goodfinds_seller_message_draft"));
  assert.equal(conversationWrites.includes("request_goodfinds_seller_action"), false);
} finally {
  await act(async () => root.unmount());
  rmSync(folder, { recursive: true, force: true });
  await dom.happyDOM.abort();
}
