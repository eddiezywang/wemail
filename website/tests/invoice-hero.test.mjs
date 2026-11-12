import assert from "node:assert/strict";
import test from "node:test";
import {
  enhanceInvoiceHero,
  initialInvoiceHeroState,
  invoiceHeroPhase,
  reduceInvoiceHeroState,
  supportsInvoiceHeroEnhancement,
} from "../src/scripts/invoice-hero.mjs";

class FakeTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(value) {
    this.values.add(value);
  }

  remove(value) {
    this.values.delete(value);
  }

  contains(value) {
    return this.values.has(value);
  }
}

function createHarness({ reducedMotion = false, visibilityState = "visible" } = {}) {
  const viewport = new FakeTarget();
  const queriedSelectors = [];
  const root = {
    dataset: { animationState: "complete" },
    classList: new FakeClassList(),
    get offsetWidth() {
      return 100;
    },
    querySelector(selector) {
      queriedSelectors.push(selector);
      if (selector === "[data-invoice-hero-viewport]") return viewport;
      return null;
    },
  };
  const media = new FakeTarget();
  media.matches = reducedMotion;
  const environment = new FakeTarget();
  environment.matchMedia = () => media;
  const documentRef = new FakeTarget();
  documentRef.visibilityState = visibilityState;
  return {
    root,
    viewport,
    queriedSelectors,
    media,
    environment,
    documentRef,
  };
}

test("state plays by default and pauses for hover or hidden pages", () => {
  let state = initialInvoiceHeroState(false, true);
  assert.deepEqual(state, {
    reducedMotion: false,
    pageVisible: true,
    hoverPaused: false,
  });
  assert.equal(invoiceHeroPhase(state), "playing");
  state = reduceInvoiceHeroState(state, { type: "HOVER", paused: true });
  assert.equal(invoiceHeroPhase(state), "paused");
  state = reduceInvoiceHeroState(state, { type: "HOVER", paused: false });
  state = reduceInvoiceHeroState(state, { type: "PAGE_VISIBILITY", visible: false });
  assert.equal(invoiceHeroPhase(state), "paused");
});

test("reduced motion always exposes the completed state", () => {
  const state = initialInvoiceHeroState(true, true);
  assert.equal(invoiceHeroPhase(state), "complete");
});

test("enhancement requires every browser API used by the controller", () => {
  assert.equal(supportsInvoiceHeroEnhancement({}, {}), false);
  assert.equal(supportsInvoiceHeroEnhancement({ matchMedia() {} }, {}), false);
  assert.equal(supportsInvoiceHeroEnhancement(
    { matchMedia() {}, addEventListener() {}, removeEventListener() {} },
    { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" },
  ), false);
  const harness = createHarness();
  assert.equal(supportsInvoiceHeroEnhancement(
    harness.environment,
    harness.documentRef,
  ), true);
});

test("unavailable browser APIs preserve the static completed DOM", () => {
  const harness = createHarness();
  const unsupportedEnvironment = {
    addEventListener() {},
    matchMedia: harness.environment.matchMedia,
  };

  enhanceInvoiceHero(harness.root, unsupportedEnvironment, harness.documentRef);

  assert.equal(harness.root.dataset.animationState, "complete");
  assert.equal(harness.root.dataset.invoiceHeroEnhanced, undefined);
  assert.equal(harness.viewport.listenerCount("pointerenter"), 0);
  assert.deepEqual(harness.queriedSelectors, []);
});

test("enhancement autoplays and follows reduced motion without replay bookkeeping", () => {
  const harness = createHarness();
  const cleanup = enhanceInvoiceHero(
    harness.root,
    harness.environment,
    harness.documentRef,
  );

  assert.equal(harness.root.dataset.animationState, "playing");
  assert.equal(harness.root.dataset.replayKey, undefined);
  assert.equal(harness.root.classList.contains("is-replaying"), false);
  assert.deepEqual(harness.queriedSelectors, ["[data-invoice-hero-viewport]"]);

  harness.media.matches = true;
  harness.media.dispatch("change", { matches: true });
  assert.equal(harness.root.dataset.animationState, "complete");

  harness.media.matches = false;
  harness.media.dispatch("change", { matches: false });
  assert.equal(harness.root.dataset.animationState, "playing");
  cleanup();
});

test("reduced-motion enhancement exposes the completed state", () => {
  const harness = createHarness({ reducedMotion: true });
  const cleanup = enhanceInvoiceHero(
    harness.root,
    harness.environment,
    harness.documentRef,
  );

  assert.equal(harness.root.dataset.animationState, "complete");
  assert.equal(harness.root.dataset.replayKey, undefined);
  cleanup();
});

test("DOM enhancement pauses and resumes automatic playback", () => {
  const harness = createHarness();
  enhanceInvoiceHero(
    harness.root,
    harness.environment,
    harness.documentRef,
  );

  assert.equal(harness.root.dataset.animationState, "playing");
  assert.equal(harness.root.dataset.invoiceHeroEnhanced, "true");
  harness.viewport.dispatch("pointerenter");
  assert.equal(harness.root.dataset.animationState, "paused");
  harness.viewport.dispatch("pointerleave");
  assert.equal(harness.root.dataset.animationState, "playing");

  harness.documentRef.visibilityState = "hidden";
  harness.documentRef.dispatch("visibilitychange");
  assert.equal(harness.root.dataset.animationState, "paused");

  harness.media.matches = true;
  harness.media.dispatch("change", { matches: true });
  assert.equal(harness.root.dataset.animationState, "complete");
  assert.equal(harness.environment.listenerCount("pagehide"), 1);
  assert.equal(harness.environment.listenerCount("pageshow"), 1);
});

test("persisted pagehide preserves the enhanced controller", () => {
  const harness = createHarness();
  const cleanup = enhanceInvoiceHero(
    harness.root,
    harness.environment,
    harness.documentRef,
  );

  harness.environment.dispatch("pagehide", { persisted: true });
  assert.equal(harness.viewport.listenerCount("pointerenter"), 1);
  assert.equal(harness.documentRef.listenerCount("visibilitychange"), 1);
  assert.equal(harness.media.listenerCount("change"), 1);
  assert.equal(harness.environment.listenerCount("pagehide"), 1);
  assert.equal(harness.environment.listenerCount("pageshow"), 1);
  assert.equal(harness.root.dataset.invoiceHeroEnhanced, "true");
  cleanup();
});

test("pageshow resynchronizes visibility after bfcache restoration", () => {
  const harness = createHarness();
  const cleanup = enhanceInvoiceHero(
    harness.root,
    harness.environment,
    harness.documentRef,
  );

  harness.documentRef.visibilityState = "hidden";
  harness.documentRef.dispatch("visibilitychange");
  assert.equal(harness.root.dataset.animationState, "paused");
  harness.environment.dispatch("pagehide", { persisted: true });

  harness.documentRef.visibilityState = "visible";
  harness.environment.dispatch("pageshow", { persisted: true });
  assert.equal(harness.root.dataset.animationState, "playing");
  cleanup();
});

test("non-persisted pagehide cleanup is idempotent and permits safe re-enhancement", () => {
  const harness = createHarness();
  const cleanup = enhanceInvoiceHero(
    harness.root,
    harness.environment,
    harness.documentRef,
  );

  harness.environment.dispatch("pagehide", { persisted: false });
  assert.equal(harness.viewport.listenerCount("pointerenter"), 0);
  assert.equal(harness.documentRef.listenerCount("visibilitychange"), 0);
  assert.equal(harness.media.listenerCount("change"), 0);
  assert.equal(harness.environment.listenerCount("pagehide"), 0);
  assert.equal(harness.environment.listenerCount("pageshow"), 0);
  assert.equal(harness.root.dataset.invoiceHeroEnhanced, undefined);

  cleanup();
  cleanup();
  const reenhance = enhanceInvoiceHero(
    harness.root,
    harness.environment,
    harness.documentRef,
  );
  assert.equal(harness.viewport.listenerCount("pointerenter"), 1);
  assert.equal(harness.documentRef.listenerCount("visibilitychange"), 1);
  assert.equal(harness.media.listenerCount("change"), 1);
  assert.equal(harness.environment.listenerCount("pagehide"), 1);
  assert.equal(harness.environment.listenerCount("pageshow"), 1);
  reenhance();
  assert.equal(harness.environment.listenerCount("pagehide"), 0);
  assert.equal(harness.environment.listenerCount("pageshow"), 0);
});
