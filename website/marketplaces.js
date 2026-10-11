import { currentExampleCountry, saveExampleCountry } from "./locale.js";
import { localiseMarketplaces, marketplaceRegions } from "./marketplace-examples.js";

// A neutral first example remains readable without JavaScript.
const carousel = document.querySelector("[data-marketplace-carousel]");

if (carousel instanceof HTMLElement) {
  const carouselElement = carousel;
  let country = currentExampleCountry();
  localiseMarketplaces(carousel, country);
  const allSlides = [...carousel.querySelectorAll(".marketplace-slide")].filter(
    (element) => element instanceof HTMLElement,
  );
  const allChoices = [...carousel.querySelectorAll("[data-marketplace]")].filter(
    (element) => element instanceof HTMLButtonElement,
  );
  const announcement = carousel.querySelector("[data-carousel-announcement]");
  const choiceList = carousel.querySelector(".marketplace-list");
  let slides = allSlides.filter((slide) => slide.dataset["regionVisible"] === "true");
  let choices = allChoices.filter(
    (choice) => choice.parentElement?.dataset["regionVisible"] === "true",
  );
  const selector = document.querySelector("[data-example-country]");

  if (
    slides.length > 0 &&
    slides.length === choices.length &&
    announcement instanceof HTMLElement &&
    choiceList instanceof HTMLElement
  ) {
    const liveRegion = announcement;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let index = 0;
    let playing = !motion.matches;
    let hovered = carousel.matches(":hover") && window.matchMedia("(hover: hover)").matches;
    let inView = false;
    /** @type {number | undefined} */
    let timer;

    function schedule() {
      window.clearTimeout(timer);
      timer = undefined;
      if (slides.length < 2 || !playing || hovered || !inView || document.hidden) return;
      timer = window.setTimeout(() => {
        index = (index + 1) % slides.length;
        render();
      }, 6000);
    }

    function render() {
      allSlides.forEach((slide) => {
        const active = slide === slides[index];
        slide.classList.toggle("is-active", active);
        slide.setAttribute("aria-hidden", String(!active));
        slide.inert = !active;
      });
      allChoices.forEach((choice) => {
        choice.setAttribute("aria-pressed", String(choice === choices[index]));
      });
      schedule();
    }

    /** @param {number} selected */
    function select(selected) {
      index = (selected + slides.length) % slides.length;
      playing = false;
      render();
      const slide = slides[index];
      const title = slide?.querySelector("h3")?.innerText.replace(/\s+/g, " ").trim();
      liveRegion.textContent = `${slide?.dataset["marketplaceName"]}: ${title}`;
    }

    allChoices.forEach((choice) => {
      choice.disabled = false;
      choice.addEventListener("click", () => select(choices.indexOf(choice)));
    });

    /** @param {string | null} next */
    function changeCountry(next) {
      const slot = slides[index]?.dataset["exampleSlot"];
      country = next;
      localiseMarketplaces(carouselElement, country);
      slides = allSlides.filter((slide) => slide.dataset["regionVisible"] === "true");
      choices = allChoices.filter(
        (choice) => choice.parentElement?.dataset["regionVisible"] === "true",
      );
      index = Math.max(
        0,
        slides.findIndex((slide) => slide.dataset["exampleSlot"] === slot),
      );
      if (selector instanceof HTMLSelectElement)
        selector.value = country && marketplaceRegions[country] ? country : "other";
      render();
    }
    if (selector instanceof HTMLSelectElement) {
      const names = new Intl.DisplayNames(navigator.languages, { type: "region" });
      for (const code of Object.keys(marketplaceRegions).toSorted((a, b) =>
        (names.of(a) ?? a).localeCompare(names.of(b) ?? b),
      )) {
        const option = document.createElement("option");
        option.value = code;
        option.textContent = names.of(code) ?? code;
        selector.append(option);
      }
      selector.value = country && marketplaceRegions[country] ? country : "other";
      if (selector.parentElement) selector.parentElement.hidden = false;
      selector.addEventListener("change", () => {
        playing = false;
        changeCountry(selector.value === "other" ? null : selector.value);
        saveExampleCountry(selector.value);
        liveRegion.textContent = `Examples updated for ${selector.selectedOptions[0]?.textContent}.`;
      });
    }
    window.addEventListener("languagechange", () => changeCountry(currentExampleCountry()));

    carousel.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "mouse" || event.pointerType === "pen") {
        hovered = true;
        schedule();
      }
    });
    carousel.addEventListener("pointerleave", () => {
      hovered = false;
      schedule();
    });
    carousel.addEventListener("focusin", (event) => {
      if (!(event.relatedTarget instanceof Node) || !carousel.contains(event.relatedTarget)) {
        playing = false;
        render();
      }
    });
    choiceList.addEventListener("keydown", (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const focused = choices.findIndex((choice) => choice === event.target);
      if (focused < 0) return;
      let selected;
      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          selected = (focused + 1) % choices.length;
          break;
        case "ArrowLeft":
        case "ArrowUp":
          selected = (focused - 1 + choices.length) % choices.length;
          break;
        case "Home":
          selected = 0;
          break;
        case "End":
          selected = choices.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      choices[selected]?.focus();
      select(selected);
    });

    motion.addEventListener("change", () => {
      if (motion.matches) playing = false;
      render();
    });
    document.addEventListener("visibilitychange", schedule);
    window.addEventListener("pagehide", () => window.clearTimeout(timer));
    window.addEventListener("pageshow", schedule);

    // Stacking the slides reserves the tallest slide's height at every width.
    // This prevents automatic rotation from moving content below the carousel.
    render();
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(
        ([entry]) => {
          inView = (entry?.intersectionRatio ?? 0) >= 0.25;
          schedule();
        },
        { threshold: 0.25 },
      ).observe(carousel);
    } else {
      inView = true;
      schedule();
    }
  }
}
