export function initialInvoiceHeroState(reducedMotion, pageVisible = true) {
  return {
    reducedMotion: Boolean(reducedMotion),
    pageVisible: Boolean(pageVisible),
    hoverPaused: false,
  };
}

export function reduceInvoiceHeroState(state, event) {
  switch (event.type) {
    case "HOVER":
      return { ...state, hoverPaused: Boolean(event.paused) };
    case "PAGE_VISIBILITY":
      return { ...state, pageVisible: Boolean(event.visible) };
    case "REDUCED_MOTION":
      return { ...state, reducedMotion: Boolean(event.matches) };
    default:
      return state;
  }
}

export function invoiceHeroPhase(state) {
  if (state.reducedMotion) return "complete";
  if (!state.pageVisible || state.hoverPaused) return "paused";
  return "playing";
}

export function supportsInvoiceHeroEnhancement(environment, documentRef) {
  if (
    typeof environment?.matchMedia !== "function"
    || typeof environment?.addEventListener !== "function"
    || typeof environment?.removeEventListener !== "function"
    || typeof documentRef?.addEventListener !== "function"
    || typeof documentRef?.removeEventListener !== "function"
    || typeof documentRef?.visibilityState !== "string"
  ) return false;

  try {
    const media = environment.matchMedia("(prefers-reduced-motion: reduce)");
    return typeof media?.addEventListener === "function"
      && typeof media?.removeEventListener === "function";
  } catch {
    return false;
  }
}

function applyInvoiceHeroState(root, state) {
  const phase = invoiceHeroPhase(state);
  root.dataset.animationState = phase;
}

export function enhanceInvoiceHero(
  root,
  environment = window,
  documentRef = document,
) {
  if (root.dataset.invoiceHeroEnhanced === "true") return () => {};
  if (!supportsInvoiceHeroEnhancement(environment, documentRef)) return () => {};

  root.dataset.invoiceHeroEnhanced = "true";
  const viewport = root.querySelector("[data-invoice-hero-viewport]");
  const media = environment.matchMedia("(prefers-reduced-motion: reduce)");
  let state = initialInvoiceHeroState(
    media.matches,
    documentRef.visibilityState !== "hidden",
  );

  const render = () => applyInvoiceHeroState(root, state);
  const handlePointerEnter = () => {
    state = reduceInvoiceHeroState(state, { type: "HOVER", paused: true });
    render();
  };
  const handlePointerLeave = () => {
    state = reduceInvoiceHeroState(state, { type: "HOVER", paused: false });
    render();
  };
  const handleVisibility = () => {
    state = reduceInvoiceHeroState(state, {
      type: "PAGE_VISIBILITY",
      visible: documentRef.visibilityState !== "hidden",
    });
    render();
  };
  const handleMotion = (event) => {
    state = reduceInvoiceHeroState(state, {
      type: "REDUCED_MOTION",
      matches: event.matches,
    });
    render();
  };
  const handlePageShow = () => handleVisibility();
  const handlePageHide = (event) => {
    if (!event.persisted) cleanup();
  };

  viewport?.addEventListener("pointerenter", handlePointerEnter);
  viewport?.addEventListener("pointerleave", handlePointerLeave);
  documentRef.addEventListener("visibilitychange", handleVisibility);
  media.addEventListener?.("change", handleMotion);
  render();

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    viewport?.removeEventListener("pointerenter", handlePointerEnter);
    viewport?.removeEventListener("pointerleave", handlePointerLeave);
    documentRef.removeEventListener("visibilitychange", handleVisibility);
    media.removeEventListener?.("change", handleMotion);
    environment.removeEventListener?.("pagehide", handlePageHide);
    environment.removeEventListener?.("pageshow", handlePageShow);
    delete root.dataset.invoiceHeroEnhanced;
  };

  environment.addEventListener?.("pagehide", handlePageHide);
  environment.addEventListener?.("pageshow", handlePageShow);
  return cleanup;
}

export function enhanceInvoiceHeroes(
  scope = document,
  environment = window,
  documentRef = document,
) {
  return Array.from(scope.querySelectorAll("[data-invoice-hero]"), (root) =>
    enhanceInvoiceHero(root, environment, documentRef));
}
