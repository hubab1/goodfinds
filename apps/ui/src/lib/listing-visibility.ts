// Visibility is buyer exposure, not an agent reading or rendering a card.
export function observeListingVisibility(element: HTMLElement, markSeen: () => Promise<boolean>) {
  let visible = false;
  let disposed = false;
  let complete = false;
  let saving = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const eligible = () =>
    visible &&
    !document.hidden &&
    element.isConnected &&
    !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
    !document.querySelector('[role="dialog"][aria-modal="true"]');
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  function update(delay = 1000) {
    if (disposed || complete) return;
    if (!eligible()) {
      clear();
      return;
    }
    if (timer || saving) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!eligible()) return;
      saving = true;
      void markSeen()
        .catch(() => false)
        .then((success) => {
          saving = false;
          complete = success;
          if (!disposed && !success) update(5000);
        });
    }, delay);
  }
  const observer = new IntersectionObserver(
    (entries) => {
      const entry = entries.at(-1);
      if (!entry) return;
      const minimumHeight = Math.min(entry.boundingClientRect.height / 2, window.innerHeight / 2);
      const minimumWidth = Math.min(entry.boundingClientRect.width / 2, window.innerWidth / 2);
      visible =
        entry.isIntersecting &&
        entry.intersectionRect.height >= minimumHeight &&
        entry.intersectionRect.width >= minimumWidth &&
        minimumHeight > 0 &&
        minimumWidth > 0;
      update();
    },
    { threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] },
  );
  observer.observe(element);
  const onVisibility = () => update();
  document.addEventListener("visibilitychange", onVisibility);
  // Dialogs and inactive tabs can obscure a card without changing its intersection.
  const mutations = new MutationObserver(onVisibility);
  mutations.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-hidden", "hidden", "inert", "aria-modal"],
  });
  return () => {
    disposed = true;
    clear();
    observer.disconnect();
    mutations.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
