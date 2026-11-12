export function initialDemoState(reducedMotion) {
  return {
    visible: false,
    reducedMotion: Boolean(reducedMotion),
  };
}

export function reduceDemoState(state, event) {
  switch (event.type) {
    case "VISIBILITY":
      return { ...state, visible: Boolean(event.visible) };
    case "REDUCED_MOTION":
      return { ...state, reducedMotion: Boolean(event.matches) };
    default:
      return state;
  }
}

export function demoPhase(state) {
  if (state.reducedMotion) return "complete";
  if (state.visible) return "playing";
  return "paused";
}

export function supportsFeatureDemoEnhancement(environment) {
  return typeof environment?.matchMedia === "function"
    && typeof environment?.IntersectionObserver === "function";
}

function applyState(root, state) {
  root.dataset.demoState = demoPhase(state);
}

function enhanceFeatureDemo(root) {
  if (root.dataset.demoEnhanced === "true") return;
  if (!supportsFeatureDemoEnhancement(window)) return;
  root.dataset.demoEnhanced = "true";
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  let state = initialDemoState(media.matches);
  const render = () => applyState(root, state);

  const observer = new window.IntersectionObserver(
    ([entry]) => {
      state = reduceDemoState(state, { type: "VISIBILITY", visible: entry.isIntersecting });
      render();
    },
    { threshold: 0.35 },
  );
  observer.observe(root);

  const handleMotionChange = (event) => {
    state = reduceDemoState(state, { type: "REDUCED_MOTION", matches: event.matches });
    render();
  };
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", handleMotionChange);
  }
  render();
}

export function enhanceFeatureDemos(scope = document) {
  scope.querySelectorAll("[data-feature-demo]").forEach(enhanceFeatureDemo);
}
