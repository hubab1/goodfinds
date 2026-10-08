import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LocationPage } from "@/features/settings/location-page";
import { GoodfindsApp } from "@/App";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Goodfinds’s panel is missing its root element");
createRoot(root).render(
  <StrictMode>
    <TooltipProvider delay={250}>
      {window.__GOODFINDS_PREVIEW__?.locationOnly ? <LocationPage /> : <GoodfindsApp />}
    </TooltipProvider>
  </StrictMode>,
);
