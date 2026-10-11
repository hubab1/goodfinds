import release from "./current-release.js";
import { installerAsset, installerFilmBase, installerOpenStep, targets } from "./releases.js";
import { computerHints, detectComputer } from "./platform.js";

/** @template {Element} T @param {string} selector @param {new () => T} type */
function element(selector, type) {
  const found = document.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`Missing download page element: ${selector}`);
  return found;
}
const button = element("#download-button", HTMLAnchorElement);
const label = element("#download-label", HTMLElement);
const status = element("#download-status", HTMLElement);
const title = element("#download-title", HTMLElement);
const intro = element("#download-intro", HTMLElement);
const openStep = element("#open-step", HTMLElement);
const alternative = element("#mac-alternative", HTMLElement);
const osChoices = [...document.querySelectorAll("input")].filter((input) => input.name === "os");
let computer = detectComputer(navigator);
let os = computer.os ?? "macos";
let manuallySelected = false;

function target() {
  return os === "macos"
    ? "macos-universal"
    : `windows-${computer.os === "windows" ? computer.chip : "x64"}`;
}

function refresh() {
  const selected = target();
  const asset = installerAsset(release, selected);
  for (const input of osChoices) input.checked = input.value === os;
  alternative.hidden = !!asset || os === "macos";
  button.setAttribute("aria-disabled", String(!asset));
  const definition = targets[selected];
  if (asset && definition) {
    button.href = asset.browser_download_url;
    label.textContent = definition.label;
    status.textContent = `Version ${release.tag_name.replace(/^v/, "")} · ${(asset.size / 1_000_000).toFixed(1)} MB · ${definition.requirement}`;
  } else {
    button.removeAttribute("href");
    label.textContent = "Not in this release";
    status.textContent =
      os === "macos"
        ? "The Mac installer is not available in this release."
        : "A Windows installer has not been published. This release is available for Mac.";
  }
  openStep.textContent = installerOpenStep(selected);
}
for (const input of osChoices)
  input.addEventListener("change", () => {
    manuallySelected = true;
    os = input.value;
    refresh();
  });
alternative.addEventListener("click", (event) => {
  event.preventDefault();
  manuallySelected = true;
  os = "macos";
  refresh();
  button.focus();
});
button.addEventListener("click", (event) => {
  if (!installerAsset(release, target())) {
    event.preventDefault();
    return;
  }
  title.textContent = "Thanks for downloading.";
  intro.textContent = "Your next good find is a few clicks away. Here’s how to get started.";
  label.textContent = "Download again";
  status.textContent =
    "Your download has been requested. If it doesn’t start, click Download again.";
});
refresh();
const releaseLink = element("#release-notes", HTMLAnchorElement);
if (installerAsset(release, "macos-universal")) {
  releaseLink.href = release.html_url;
  releaseLink.hidden = false;
}
void computerHints(navigator).then((hints) => {
  computer = detectComputer(navigator, hints);
  if (!manuallySelected) {
    os = computer.os ?? "macos";
  }
  refresh();
});

const film = element("#install-film", HTMLVideoElement);
const filmBase = installerFilmBase();
const filmSource = element("#install-film source", HTMLElement);
if (filmSource.getAttribute("src") !== `${filmBase}.mp4`) {
  film.poster = `${filmBase}-poster.webp`;
  filmSource.setAttribute("src", `${filmBase}.mp4`);
  film.load();
}
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
reducedMotion.addEventListener("change", () => {
  if (reducedMotion.matches) film.pause();
});
const connection = "connection" in navigator ? navigator.connection : null;
const saveData =
  connection && typeof connection === "object" && "saveData" in connection && connection.saveData;
if (!reducedMotion.matches && !saveData) void film.play().catch(() => {});
