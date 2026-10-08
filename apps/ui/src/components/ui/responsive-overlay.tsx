import { useRef, useSyncExternalStore } from "react";
import type { ReactNode, RefObject } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Drawer } from "@base-ui/react/drawer";
import { X } from "lucide-react";
import { dialogInitialFocus } from "./dialog-focus";
import "./responsive-overlay.css";

const COMPACT_QUERY = "(max-width: 639px)";

function subscribeToWidth(onChange: () => void): () => void {
  const query = window.matchMedia(COMPACT_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function compactSnapshot(): boolean {
  return window.matchMedia(COMPACT_QUERY).matches;
}

export type ResponsiveOverlayProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  returnFocus?: RefObject<HTMLElement | null>;
};

// Keep controlled form state in the caller so changing containers preserves the draft.
export function ResponsiveOverlay({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  returnFocus,
}: ResponsiveOverlayProps) {
  const compact = useSyncExternalStore(subscribeToWidth, compactSnapshot, () => false);
  const popup = useRef<HTMLDivElement>(null);

  if (compact) {
    return (
      <Drawer.Root open={open} onOpenChange={onOpenChange} swipeDirection="down">
        <Drawer.VirtualKeyboardProvider>
          <Drawer.Portal>
            <Drawer.Backdrop className="responsive-overlay-backdrop" />
            <Drawer.Viewport className="responsive-overlay-viewport">
              <Drawer.Popup
                ref={popup}
                className="responsive-overlay-popup responsive-overlay-sheet"
                initialFocus={popup}
                finalFocus={returnFocus}
              >
                <Drawer.SwipeArea className="responsive-overlay-handle-area">
                  <span className="responsive-overlay-handle" aria-hidden="true" />
                </Drawer.SwipeArea>
                <header className="responsive-overlay-header">
                  <Drawer.Title className="responsive-overlay-title">{title}</Drawer.Title>
                  {description && (
                    <Drawer.Description className="responsive-overlay-description">
                      {description}
                    </Drawer.Description>
                  )}
                  <Drawer.Close className="responsive-overlay-close" aria-label="Close">
                    <X size={18} aria-hidden="true" />
                  </Drawer.Close>
                </header>
                <Drawer.Content className="responsive-overlay-body">{children}</Drawer.Content>
                {footer && <footer className="responsive-overlay-footer">{footer}</footer>}
              </Drawer.Popup>
            </Drawer.Viewport>
          </Drawer.Portal>
        </Drawer.VirtualKeyboardProvider>
      </Drawer.Root>
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="responsive-overlay-backdrop" />
        <Dialog.Popup
          ref={popup}
          className="responsive-overlay-popup responsive-overlay-dialog"
          initialFocus={(interaction) => dialogInitialFocus(popup.current, interaction)}
          finalFocus={returnFocus}
        >
          <header className="responsive-overlay-header">
            <Dialog.Title className="responsive-overlay-title">{title}</Dialog.Title>
            {description && (
              <Dialog.Description className="responsive-overlay-description">
                {description}
              </Dialog.Description>
            )}
            <Dialog.Close className="responsive-overlay-close" aria-label="Close">
              <X size={18} aria-hidden="true" />
            </Dialog.Close>
          </header>
          <div className="responsive-overlay-body">{children}</div>
          {footer && <footer className="responsive-overlay-footer">{footer}</footer>}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
