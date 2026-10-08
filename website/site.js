const previews = {
  requirements: {
    src: "media/requirements.jpg",
    alt: "Actual Goodfinds search details with fictional minimum specifications, budget and travel limit.",
    caption:
      "Make the must-haves explicit. Adjust your budget, specifications and travel limit in the search.",
  },
  listing: {
    src: "media/listing.jpg",
    alt: "Actual Goodfinds detail panel for a fictional MacBook Pro listing, showing asking price, chip, memory, storage and condition.",
    caption:
      "Keep the asking price, specifications and seller details together, ready for a closer look.",
  },
  message: {
    src: "media/message.jpg",
    alt: "Actual Goodfinds message review with a fictional draft asking about battery health and the charger. No seller is contacted.",
    caption:
      "Ask about the details that matter. Save a draft or review the next step before sending.",
  },
};
const image = document.querySelector("#preview-image");
const caption = document.querySelector("#preview-caption");
const buttons = document.querySelectorAll("[data-view]");
for (const button of buttons) {
  button.addEventListener("click", () => {
    const key = button.getAttribute("data-view");
    if (key !== "requirements" && key !== "listing" && key !== "message") return;
    if (!(image instanceof HTMLImageElement) || !caption) return;
    const preview = previews[key];
    image.src = preview.src;
    image.alt = preview.alt;
    caption.textContent = preview.caption;
    for (const sibling of buttons) sibling.setAttribute("aria-pressed", String(sibling === button));
  });
}
