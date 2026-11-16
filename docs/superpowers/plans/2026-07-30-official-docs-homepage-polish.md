# Official Documentation Homepage Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the official documentation landing page's static hero and three small demos with one full-width, real-WeMail invoice workflow animation, while fixing brand assets, heading contrast, and shared installation links.

**Architecture:** Keep `website/` independently buildable. Add one website-local install-link module, one invoice-hero Astro component, one pure state/controller module, and one dedicated stylesheet; integrate them through the existing landing components without importing React, Electron, desktop services, or real mailbox data. Preserve the existing feature demos for Starlight feature pages, because invoices and MCP documentation still consume them.

**Tech Stack:** Astro 5.18, Starlight 0.37, semantic HTML, CSS keyframes, browser DOM APIs, Node 22 `node:test`.

## Global Constraints

- `website/` must remain independently installable, buildable, testable, and usable as the Docker build context.
- Do not import React renderer components, Tailwind styles, Electron APIs, desktop state, server services, or shared mailbox data into `website/`.
- The hero must use anonymous fixed example data and perform no runtime network request.
- The hero must show the real four-region WeMail layout: navigation, message list, message reader, and `WeMail AI` panel.
- The workflow must show AI analysis, tool progress, explicit user confirmation, and `成功 1 个，失败 0 个`.
- Automatic playback must support hover pause, replay, page-visibility pause, listener cleanup, and `prefers-reduced-motion`.
- No-JavaScript and unsupported-animation paths must expose a meaningful completed static state.
- Narrow screens must not require horizontal scrolling to understand the hero.
- The complete landing-page `产品亮点` section and its three demo cards must be removed.
- Existing `探索能力` and local-first security sections must remain.
- `electron/assets/wemail-icon.svg` is the canonical logo; website-local copies must match it without creating a runtime or Docker dependency on repository-external files.
- Both installation calls to action must read one shared configuration value whose initial target is `/getting-started/install/`.
- Do not add a release-history page or release-history navigation entry.

---

## File Structure

### Files to create

- `website/src/config/site-links.mjs` — validates and exports the shared installation link attributes.
- `website/tests/site-links.test.mjs` — unit tests internal, external, and invalid link targets.
- `website/tests/brand-theme.test.mjs` — verifies canonical logo equality and light-theme heading colors.
- `website/src/scripts/invoice-hero.mjs` — pure playback state plus DOM enhancement and cleanup.
- `website/tests/invoice-hero.test.mjs` — unit tests state transitions, DOM event behavior, replay, and cleanup.
- `website/src/components/landing/InvoiceHeroDemo.astro` — semantic real-App invoice scene and controls.
- `website/src/styles/invoice-hero.css` — four-region layout, animation timeline, pause, static, responsive, and reduced-motion states.
- `website/tests/invoice-hero-markup.test.mjs` — source-level contract tests for required product regions, copy, and CSS fallbacks.

### Files to modify

- `website/package.json` — include each new focused test in the explicit `node --test` command.
- `website/src/assets/wemail-logo.svg` — replace the temporary W logo with the canonical orange envelope SVG.
- `website/public/favicon.svg` — replace the temporary W logo with the canonical orange envelope SVG.
- `website/src/styles/custom.css` — restore Starlight's light-theme foreground semantics and sidebar heading contrast.
- `website/src/components/landing/Hero.astro` — consume shared install attributes and render `InvoiceHeroDemo`.
- `website/src/components/landing/SiteHeader.astro` — consume shared install attributes and remove the deleted highlights anchor.
- `website/src/layouts/LandingLayout.astro` — import the invoice-hero stylesheet instead of landing-only feature-demo styles.
- `website/src/pages/index.astro` — remove the three demo imports and the complete `产品亮点` section.
- `website/src/styles/landing.css` — remove the old static hero-window and demo-grid rules; add spacing for the full-width hero product scene.
- `website/tests/build-output.test.mjs` — assert the revised landing structure, successful invoice flow, removed demos, and shared install target.

### File to delete

- `website/src/components/demos/ActionLoopDemo.astro` — becomes unreferenced when the landing-page demo grid is removed; invoice and MCP demo components remain in use on feature pages.

### Files intentionally retained

- `website/src/components/demos/FeatureDemo.astro`
- `website/src/components/demos/InvoiceDemo.astro`
- `website/src/components/demos/McpDemo.astro`
- `website/src/scripts/feature-demo.mjs`
- `website/src/styles/feature-demos.css`

`features/invoices.mdx` and `features/mcp.mdx` still render existing feature demonstrations, so deleting these files would break documentation pages.

---

### Task 1: Centralize and validate installation link attributes

**Files:**
- Create: `website/src/config/site-links.mjs`
- Create: `website/tests/site-links.test.mjs`
- Modify: `website/package.json`

**Interfaces:**
- Produces: `INSTALL_URL: string`
- Produces: `linkAttributes(url: string): Readonly<{ href: string; target?: "_blank"; rel?: "noopener noreferrer" }>`
- Produces: `INSTALL_LINK_ATTRIBUTES`, consumed by `Hero.astro` and `SiteHeader.astro` in Task 5.

- [ ] **Step 1: Write the failing site-link tests**

Create `website/tests/site-links.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import {
  INSTALL_LINK_ATTRIBUTES,
  INSTALL_URL,
  linkAttributes,
} from "../src/config/site-links.mjs";

test("installation links initially target the curated install guide", () => {
  assert.equal(INSTALL_URL, "/getting-started/install/");
  assert.deepEqual(INSTALL_LINK_ATTRIBUTES, {
    href: "/getting-started/install/",
  });
});

test("internal documentation links stay in the current browsing context", () => {
  assert.deepEqual(linkAttributes("/features/invoices/"), {
    href: "/features/invoices/",
  });
});

test("future HTTPS installer links receive safe external attributes", () => {
  assert.deepEqual(linkAttributes("https://downloads.example.com/WeMail.exe"), {
    href: "https://downloads.example.com/WeMail.exe",
    target: "_blank",
    rel: "noopener noreferrer",
  });
});

test("empty, fragment-only, protocol-relative, and insecure targets are rejected", () => {
  for (const value of ["", "#", "//downloads.example.com/app.exe", "http://example.com/app.exe"]) {
    assert.throws(() => linkAttributes(value), /valid internal path or HTTPS URL/);
  }
});
```

Modify the `test` script in `website/package.json` so the new file is explicit:

```json
"test": "node --test tests/site-links.test.mjs tests/export-raw-markdown.test.mjs tests/server.test.mjs tests/feature-demo.test.mjs tests/packaging.test.mjs"
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
node --test --test-name-pattern="installation links|internal documentation|future HTTPS|empty, fragment" website/tests/site-links.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/config/site-links.mjs`.

- [ ] **Step 3: Implement the shared link module**

Create `website/src/config/site-links.mjs`:

```javascript
const INTERNAL_PATH_PATTERN = /^\/(?!\/)[^#\s]*$/;
const HTTPS_URL_PATTERN = /^https:\/\/[^\s]+$/;

export function linkAttributes(url) {
  if (typeof url !== "string" || !url) {
    throw new TypeError("Link target must be a valid internal path or HTTPS URL");
  }
  if (INTERNAL_PATH_PATTERN.test(url)) {
    return Object.freeze({ href: url });
  }
  if (HTTPS_URL_PATTERN.test(url)) {
    return Object.freeze({
      href: url,
      target: "_blank",
      rel: "noopener noreferrer",
    });
  }
  throw new TypeError("Link target must be a valid internal path or HTTPS URL");
}

export const INSTALL_URL = "/getting-started/install/";
export const INSTALL_LINK_ATTRIBUTES = linkAttributes(INSTALL_URL);
```

- [ ] **Step 4: Run the focused and complete website unit tests**

Run:

```powershell
node --test --test-name-pattern="installation links|internal documentation|future HTTPS|empty, fragment" website/tests/site-links.test.mjs
npm --prefix website test
```

Expected: the four focused tests PASS, followed by all website unit tests PASS.

- [ ] **Step 5: Commit the shared link module**

```powershell
git add website/src/config/site-links.mjs website/tests/site-links.test.mjs website/package.json
git commit -m "refactor(docs): centralize install links"
```

---

### Task 2: Synchronize the updated logo and repair Starlight heading colors

**Files:**
- Create: `website/tests/brand-theme.test.mjs`
- Modify: `website/src/assets/wemail-logo.svg`
- Modify: `website/public/favicon.svg`
- Modify: `website/src/styles/custom.css`
- Modify: `website/package.json`

**Interfaces:**
- Consumes: canonical SVG bytes from `electron/assets/wemail-icon.svg` only during repository tests.
- Produces: matching website-local SVG assets that remain available inside the independent website Docker context.
- Produces: corrected Starlight light-theme variables consumed by every documentation page.

- [ ] **Step 1: Write the failing brand and theme tests**

Create `website/tests/brand-theme.test.mjs`:

```javascript
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const websiteRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(websiteRoot, "..");

async function read(relativeToRepository) {
  return readFile(path.join(repositoryRoot, relativeToRepository), "utf8");
}

test("website SVG brand assets match the canonical desktop logo", async () => {
  const canonical = await read("electron/assets/wemail-icon.svg");
  const starlightLogo = await read("website/src/assets/wemail-logo.svg");
  const favicon = await read("website/public/favicon.svg");
  assert.equal(starlightLogo, canonical);
  assert.equal(favicon, canonical);
});

test("light theme uses a dark heading foreground and readable sidebar groups", async () => {
  const css = await read("website/src/styles/custom.css");
  assert.match(css, /--sl-color-white:\s*#2d2825;/);
  assert.match(css, /--sl-color-black:\s*#fffdfb;/);
  assert.match(css, /\.sidebar-content \.group-label \.large\s*\{[^}]*color:\s*var\(--sl-color-gray-2\);[^}]*opacity:\s*1;/s);
});

test("dark theme retains a light heading foreground", async () => {
  const css = await read("website/src/styles/custom.css");
  assert.match(css, /:root\[data-theme="dark"\][\s\S]*--sl-color-white:\s*#f7f1ee;/);
});
```

Add the test to the explicit `website/package.json` script:

```json
"test": "node --test tests/site-links.test.mjs tests/brand-theme.test.mjs tests/export-raw-markdown.test.mjs tests/server.test.mjs tests/feature-demo.test.mjs tests/packaging.test.mjs"
```

- [ ] **Step 2: Run the focused tests and verify the temporary logo and heading color fail**

Run:

```powershell
node --test --test-name-pattern="website SVG brand|light theme|dark theme" website/tests/brand-theme.test.mjs
```

Expected: FAIL because `website/src/assets/wemail-logo.svg` differs from the canonical SVG and `--sl-color-white` is `#fffaf7`.

- [ ] **Step 3: Replace both website SVG assets with the canonical artwork**

Use `apply_patch` to replace the complete contents of both `website/src/assets/wemail-logo.svg` and `website/public/favicon.svg` with this exact SVG:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-labelledby="title description">
  <title id="title">WeMail</title>
  <description id="description">An ivory envelope with a raised W fold on a saddle-orange tile.</description>
  <defs>
    <linearGradient id="saddle-orange" x1="36" y1="22" x2="224" y2="238" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#DD682D"/>
      <stop offset="0.48" stop-color="#D65A24"/>
      <stop offset="1" stop-color="#C94D20"/>
    </linearGradient>
    <linearGradient id="ivory" x1="128" y1="58" x2="128" y2="198" gradientUnits="userSpaceOnUse">
      <stop stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#FFF9F0"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="58" fill="url(#saddle-orange)"/>
  <g fill="url(#ivory)">
    <path d="M48 61H208C218 61 219 68 212 73L157 128C152 133 148 133 143 129L138 122C132 116 124 116 118 122L111 129C107 133 103 132 99 128L44 73C37 67 39 61 48 61Z"/>
    <path d="M35 82C32 82 30 85 30 89V183C30 195 42 199 51 191L99 143L35 82ZM221 82C224 82 226 85 226 89V183C226 195 214 199 205 191L157 143L221 82Z"/>
    <path d="M59 195C55 195 55 193 57 191L128 116L199 191C201 193 200 195 197 195H59Z"/>
  </g>
  <path id="upper-w-seam" d="M35 77L106 148L128 126L150 148L221 77" fill="none" stroke="#D65A24" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
  <path id="lower-envelope-seams" d="M45 194L128 116L211 194" fill="none" stroke="#D65A24" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M100 142L128 112L156 142L150 149L128 128L106 149Z" fill="#D65A24"/>
</svg>
```

- [ ] **Step 4: Correct the light palette and sidebar group heading rule**

In `website/src/styles/custom.css`, replace the light palette with:

```css
:root {
  --sl-color-accent-low: #fff0ec;
  --sl-color-accent: #d85b46;
  --sl-color-accent-high: #642417;
  --sl-color-white: #2d2825;
  --sl-color-gray-1: #3b3531;
  --sl-color-gray-2: #514943;
  --sl-color-gray-3: #756a63;
  --sl-color-gray-4: #a69a92;
  --sl-color-gray-5: #ded5cf;
  --sl-color-gray-6: #eee8e4;
  --sl-color-black: #fffdfb;
  --sl-font: Inter, "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif;
  --sl-content-width: 52rem;
}
```

Keep the existing dark-theme block unchanged, then add after `.site-title`:

```css
.sidebar-content .group-label .large {
  color: var(--sl-color-gray-2);
  opacity: 1;
}
```

- [ ] **Step 5: Run focused tests, Astro check, and complete unit tests**

Run:

```powershell
node --test --test-name-pattern="website SVG brand|light theme|dark theme" website/tests/brand-theme.test.mjs
npm --prefix website run check
npm --prefix website test
```

Expected: focused tests PASS, Astro reports no errors, all website unit tests PASS.

- [ ] **Step 6: Commit brand and theme corrections**

```powershell
git add website/src/assets/wemail-logo.svg website/public/favicon.svg website/src/styles/custom.css website/tests/brand-theme.test.mjs website/package.json
git commit -m "fix(docs): align brand assets and heading colors"
```

---

### Task 3: Add the invoice hero playback state and DOM controller

**Files:**
- Create: `website/src/scripts/invoice-hero.mjs`
- Create: `website/tests/invoice-hero.test.mjs`
- Modify: `website/package.json`

**Interfaces:**
- Produces: `initialInvoiceHeroState(reducedMotion: boolean, pageVisible?: boolean)`
- Produces: `reduceInvoiceHeroState(state, event)`
- Produces: `invoiceHeroPhase(state): "playing" | "paused" | "complete"`
- Produces: `supportsInvoiceHeroEnhancement(environment, documentRef): boolean`
- Produces: `enhanceInvoiceHero(root, environment?, documentRef?): () => void`
- Produces: `enhanceInvoiceHeroes(scope?, environment?, documentRef?): Array<() => void>`, consumed by `InvoiceHeroDemo.astro` in Task 4.

- [ ] **Step 1: Write state, enhancement, and cleanup tests**

Create `website/tests/invoice-hero.test.mjs`:

```javascript
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
  const replay = new FakeTarget();
  replay.setAttribute = (name, value) => {
    replay[name] = value;
  };
  const root = {
    dataset: { animationState: "complete" },
    classList: new FakeClassList(),
    get offsetWidth() {
      return 100;
    },
    querySelector(selector) {
      if (selector === "[data-invoice-hero-viewport]") return viewport;
      if (selector === "[data-invoice-hero-replay]") return replay;
      return null;
    },
  };
  const media = new FakeTarget();
  media.matches = reducedMotion;
  const environment = new FakeTarget();
  environment.matchMedia = () => media;
  const documentRef = new FakeTarget();
  documentRef.visibilityState = visibilityState;
  return { root, viewport, replay, media, environment, documentRef };
}

test("state plays by default and pauses for hover or hidden pages", () => {
  let state = initialInvoiceHeroState(false, true);
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

test("replay clears hover pause and increments the replay key", () => {
  let state = initialInvoiceHeroState(false, true);
  state = reduceInvoiceHeroState(state, { type: "HOVER", paused: true });
  state = reduceInvoiceHeroState(state, { type: "REPLAY" });
  assert.equal(state.hoverPaused, false);
  assert.equal(state.replayKey, 1);
  assert.equal(invoiceHeroPhase(state), "playing");
});

test("enhancement requires media-query and document event APIs", () => {
  assert.equal(supportsInvoiceHeroEnhancement({}, {}), false);
  assert.equal(supportsInvoiceHeroEnhancement({ matchMedia() {} }, {}), false);
  assert.equal(supportsInvoiceHeroEnhancement(
    { matchMedia() {} },
    { addEventListener() {}, removeEventListener() {} },
  ), true);
});

test("DOM enhancement handles hover, replay, visibility, motion, and cleanup", () => {
  const harness = createHarness();
  const cleanup = enhanceInvoiceHero(
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
  harness.replay.dispatch("click");
  assert.equal(harness.root.dataset.replayKey, "1");
  assert.equal(harness.root.classList.contains("is-replaying"), true);

  harness.documentRef.visibilityState = "hidden";
  harness.documentRef.dispatch("visibilitychange");
  assert.equal(harness.root.dataset.animationState, "paused");

  harness.media.matches = true;
  harness.media.dispatch("change", { matches: true });
  assert.equal(harness.root.dataset.animationState, "complete");
  assert.equal(harness.environment.listenerCount("pagehide"), 1);

  cleanup();
  assert.equal(harness.viewport.listenerCount("pointerenter"), 0);
  assert.equal(harness.replay.listenerCount("click"), 0);
  assert.equal(harness.documentRef.listenerCount("visibilitychange"), 0);
  assert.equal(harness.environment.listenerCount("pagehide"), 0);
  assert.equal(harness.root.dataset.invoiceHeroEnhanced, undefined);
});
```

Add the file to the explicit test command:

```json
"test": "node --test tests/site-links.test.mjs tests/brand-theme.test.mjs tests/invoice-hero.test.mjs tests/export-raw-markdown.test.mjs tests/server.test.mjs tests/feature-demo.test.mjs tests/packaging.test.mjs"
```

- [ ] **Step 2: Run the controller tests and verify they fail**

Run:

```powershell
node --test --test-name-pattern="state plays|reduced motion|replay clears|enhancement requires|DOM enhancement" website/tests/invoice-hero.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/scripts/invoice-hero.mjs`.

- [ ] **Step 3: Implement the pure state and DOM enhancement module**

Create `website/src/scripts/invoice-hero.mjs`:

```javascript
export function initialInvoiceHeroState(reducedMotion, pageVisible = true) {
  return {
    reducedMotion: Boolean(reducedMotion),
    pageVisible: Boolean(pageVisible),
    hoverPaused: false,
    replayKey: 0,
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
    case "REPLAY":
      return {
        ...state,
        hoverPaused: false,
        replayKey: state.replayKey + 1,
      };
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
  return typeof environment?.matchMedia === "function"
    && typeof documentRef?.addEventListener === "function"
    && typeof documentRef?.removeEventListener === "function";
}

function applyInvoiceHeroState(root, state) {
  const phase = invoiceHeroPhase(state);
  root.dataset.animationState = phase;
  root.dataset.replayKey = String(state.replayKey);
  const replay = root.querySelector("[data-invoice-hero-replay]");
  replay?.setAttribute("aria-disabled", String(state.reducedMotion));
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
  const replay = root.querySelector("[data-invoice-hero-replay]");
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
  const handleReplay = () => {
    if (state.reducedMotion) return;
    state = reduceInvoiceHeroState(state, { type: "REPLAY" });
    root.classList.remove("is-replaying");
    void root.offsetWidth;
    root.classList.add("is-replaying");
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

  viewport?.addEventListener("pointerenter", handlePointerEnter);
  viewport?.addEventListener("pointerleave", handlePointerLeave);
  replay?.addEventListener("click", handleReplay);
  documentRef.addEventListener("visibilitychange", handleVisibility);
  media.addEventListener?.("change", handleMotion);
  root.classList.add("is-replaying");
  render();

  const cleanup = () => {
    viewport?.removeEventListener("pointerenter", handlePointerEnter);
    viewport?.removeEventListener("pointerleave", handlePointerLeave);
    replay?.removeEventListener("click", handleReplay);
    documentRef.removeEventListener("visibilitychange", handleVisibility);
    media.removeEventListener?.("change", handleMotion);
    environment.removeEventListener?.("pagehide", cleanup);
    delete root.dataset.invoiceHeroEnhanced;
  };

  environment.addEventListener?.("pagehide", cleanup, { once: true });
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
```

- [ ] **Step 4: Run focused tests, then all website unit tests**

Run:

```powershell
node --test --test-name-pattern="state plays|reduced motion|replay clears|enhancement requires|DOM enhancement" website/tests/invoice-hero.test.mjs
npm --prefix website test
```

Expected: focused controller tests PASS and all website unit tests PASS.

- [ ] **Step 5: Commit the controller**

```powershell
git add website/src/scripts/invoice-hero.mjs website/tests/invoice-hero.test.mjs website/package.json
git commit -m "feat(docs): add invoice hero playback controller"
```

---

### Task 4: Build the real-App invoice hero component and animation stylesheet

**Files:**
- Create: `website/src/components/landing/InvoiceHeroDemo.astro`
- Create: `website/src/styles/invoice-hero.css`
- Create: `website/tests/invoice-hero-markup.test.mjs`
- Modify: `website/package.json`

**Interfaces:**
- Consumes: `enhanceInvoiceHeroes()` from Task 3.
- Produces: `<InvoiceHeroDemo />`, consumed by `Hero.astro` in Task 5.
- Produces: root contract `[data-invoice-hero][data-animation-state][data-replay-key]`.
- Produces: child contracts `[data-invoice-hero-viewport]` and `[data-invoice-hero-replay]` required by Task 3.

- [ ] **Step 1: Write the failing component and stylesheet contract tests**

Create `website/tests/invoice-hero-markup.test.mjs`:

```javascript
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("invoice hero contains the real app regions and confirmation flow", async () => {
  const component = await readFile(
    path.join(projectRoot, "src", "components", "landing", "InvoiceHeroDemo.astro"),
    "utf8",
  );
  assert.match(component, /data-invoice-hero/);
  assert.match(component, /data-invoice-hero-viewport/);
  assert.match(component, /data-invoice-hero-replay/);
  assert.match(component, /WeMail AI/);
  assert.match(component, /读取邮件/);
  assert.match(component, /处理附件/);
  assert.match(component, /需要确认/);
  assert.match(component, /上传 1 个 PDF 发票附件到发票平台/);
  assert.match(component, /上传完成：成功 1 个，失败 0 个/);
  assert.doesNotMatch(component, /@example\.com|26427000000575120566/);
});

test("invoice hero CSS defines desktop, paused, completed, narrow, and reduced-motion states", async () => {
  const css = await readFile(
    path.join(projectRoot, "src", "styles", "invoice-hero.css"),
    "utf8",
  );
  assert.match(css, /grid-template-columns:\s*12fr 21fr 38fr 29fr/);
  assert.match(css, /\[data-animation-state="paused"\]/);
  assert.match(css, /\[data-animation-state="complete"\]/);
  assert.match(css, /@media \(max-width: 62rem\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /animation-play-state:\s*paused/);
});
```

Add the file to the explicit test command:

```json
"test": "node --test tests/site-links.test.mjs tests/brand-theme.test.mjs tests/invoice-hero.test.mjs tests/invoice-hero-markup.test.mjs tests/export-raw-markdown.test.mjs tests/server.test.mjs tests/feature-demo.test.mjs tests/packaging.test.mjs"
```

- [ ] **Step 2: Run the markup tests and verify they fail**

Run:

```powershell
node --test --test-name-pattern="invoice hero contains|invoice hero CSS" website/tests/invoice-hero-markup.test.mjs
```

Expected: FAIL with `ENOENT` for `InvoiceHeroDemo.astro` and `invoice-hero.css`.

- [ ] **Step 3: Create the semantic Astro component**

Create `website/src/components/landing/InvoiceHeroDemo.astro`:

```astro
<figure
  class="invoice-hero"
  data-invoice-hero
  data-animation-state="complete"
  data-replay-key="0"
  aria-labelledby="invoice-hero-title"
  aria-describedby="invoice-hero-description"
>
  <div class="invoice-hero__toolbar">
    <div>
      <span class="invoice-hero__eyebrow">真实 App 发票流程</span>
      <h2 id="invoice-hero-title">从邮件分析到确认上传</h2>
    </div>
    <button type="button" data-invoice-hero-replay aria-label="重新播放发票处理演示">
      <span aria-hidden="true">↻</span>
      <span>重新播放</span>
    </button>
  </div>

  <p id="invoice-hero-description" class="invoice-hero__description">
    WeMail AI 阅读当前发票邮件，处理附件并创建上传确认；用户确认后，界面显示成功上传 1 个附件。
  </p>

  <div class="invoice-hero__viewport" data-invoice-hero-viewport aria-hidden="true">
    <div class="invoice-hero__titlebar">
      <img src="/favicon.svg" width="24" height="24" alt="" />
      <strong>WeMail</strong>
      <span>—　□　×</span>
    </div>

    <div class="invoice-hero__workspace">
      <aside class="invoice-hero__nav">
        <b>✎　写邮件</b>
        <span>▣　收件箱 <i>2827</i></span>
        <span>☑　待办</span>
        <span>♧　应用消息</span>
        <span>♧　通讯录</span>
        <span class="is-active">✉　所有邮件</span>
        <span class="is-child">◇　重要 <i>216</i></span>
        <span class="is-child">◇　待处理 <i>254</i></span>
        <span class="is-child">◇　订阅 <i>10</i></span>
        <span class="is-child">◇　通知 <i>7136</i></span>
        <span class="invoice-hero__account">F　WeMail 用户</span>
      </aside>

      <section class="invoice-hero__list">
        <div class="invoice-hero__search">⌕　搜索邮件…　　共 14450 封</div>
        <small>最近 7 天</small>
        <article><b>MailAlert　11:41</b><span>[Warning] OpsMonitor:Alert - 周期内…</span></article>
        <article><b>MailAlert　11:41</b><span>[Warning] OpsMonitor:Alert - 周期内…</span></article>
        <article class="is-selected">
          <b>山姆会员商店　11:33</b>
          <span>电子发票开具通知</span>
          <em>● 发票 · 未上传</em>
        </article>
        <article><b>MailAlert　11:33</b><span>[Warning] OpsMonitor:Alert - 命中次…</span></article>
        <article><b>MailAlert　11:23</b><span>[Warning] OpsMonitor:Alert - 周期内…</span></article>
      </section>

      <section class="invoice-hero__reader">
        <div class="invoice-hero__reader-tools">≪　↶　↷　◇　☆　⋮</div>
        <header>
          <h3>电子发票开具通知</h3>
          <p>会员服务　·　7 月 30 日 11:33</p>
        </header>
        <div class="invoice-hero__mail-body">
          <p><strong>尊敬的会员，您好！</strong></p>
          <p>您本月的电子发票已经开具，发票详情如下：</p>
          <p>开票金额：¥ 109.60<br />开票日期：2026-07-30</p>
          <dl>
            <div><dt>发票代码</dt><dd>0440…2056</dd></div>
            <div><dt>发票号码</dt><dd>26427…0566</dd></div>
          </dl>
        </div>
      </section>

      <section class="invoice-hero__ai">
        <header><h3>WeMail AI</h3><span>♢　⟲　↗　×</span></header>
        <div class="invoice-hero__ai-body">
          <div class="invoice-hero__prompt" data-invoice-scene="prompt">
            阅读当前邮件，查找发票附件或发票信息，并创建上传到发票平台的确认操作。
          </div>

          <div class="invoice-hero__analysis" data-invoice-scene="analysis">
            <b>已完成分析</b>
            <p>Planning default PDF upload with confirmation</p>
            <ol>
              <li><span>✉</span><div><b>读取邮件</b><small>Loaded stored mail source</small></div></li>
              <li><span>⌑</span><div><b>处理附件</b><small>Found 1 invoice attachment candidate</small></div></li>
              <li><span>✓</span><div><b>创建确认操作</b><small>等待用户确认后执行</small></div></li>
            </ol>
          </div>

          <div class="invoice-hero__confirmation" data-invoice-scene="confirmation">
            <small>需要确认</small>
            <b>上传 1 个 PDF 发票附件到发票平台</b>
            <p>确认后会上传选中的邮件附件。</p>
            <div><button type="button">拒绝</button><button type="button">确认</button></div>
            <span class="invoice-hero__pointer">➤</span>
          </div>

          <div class="invoice-hero__success" data-invoice-scene="success">
            <b>✓ 已确认执行：上传 1 个 PDF 发票附件到发票平台</b>
            <span>上传完成：成功 1 个，失败 0 个。</span>
          </div>
        </div>
        <div class="invoice-hero__composer">搜索、写作或询问任何内容</div>
      </section>
    </div>
  </div>
</figure>

<script>
  import { enhanceInvoiceHeroes } from "../../scripts/invoice-hero.mjs";
  enhanceInvoiceHeroes();
</script>
```

- [ ] **Step 4: Create the dedicated full-width and responsive animation CSS**

Create `website/src/styles/invoice-hero.css`:

```css
.invoice-hero {
  margin: 3rem 0 0;
  color: #2d2825;
  text-align: left;
}

.invoice-hero__toolbar {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.75rem;
}

.invoice-hero__eyebrow {
  color: #c94d20;
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.11em;
  text-transform: uppercase;
}

.invoice-hero__toolbar h2 {
  margin: 0.3rem 0 0;
  color: #2d2825;
  font-size: clamp(1.15rem, 2vw, 1.55rem);
  letter-spacing: -0.025em;
}

.invoice-hero__toolbar button {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.55rem 0.75rem;
  border: 1px solid #d9cdc6;
  border-radius: 0.65rem;
  background: #fff;
  color: #514943;
  font: inherit;
  font-size: 0.8rem;
  font-weight: 750;
  cursor: pointer;
}

.invoice-hero__toolbar button:focus-visible {
  outline: 3px solid #efaf93;
  outline-offset: 3px;
}

.invoice-hero__description {
  max-width: 50rem;
  margin: 0 0 1rem;
  color: #756a63;
  font-size: 0.88rem;
  line-height: 1.6;
}

.invoice-hero__viewport {
  min-height: 34rem;
  overflow: hidden;
  border: 1px solid #ded4ce;
  border-radius: 1.3rem 1.3rem 0 0;
  background: #fff;
  box-shadow: 0 2rem 6rem rgba(75, 47, 34, 0.16);
}

.invoice-hero__titlebar {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  min-height: 2.6rem;
  padding: 0 0.8rem;
  border-bottom: 1px solid #e9e3de;
  background: #fff;
}

.invoice-hero__titlebar strong {
  font-family: Georgia, "Noto Serif SC", serif;
}

.invoice-hero__titlebar span {
  margin-left: auto;
  color: #81776f;
}

.invoice-hero__workspace {
  display: grid;
  grid-template-columns: 12fr 21fr 38fr 29fr;
  min-height: 31.4rem;
}

.invoice-hero__nav,
.invoice-hero__list,
.invoice-hero__reader {
  border-right: 1px solid #e9e3de;
}

.invoice-hero__nav {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.85rem 0.55rem;
  background: #f2efe9;
  font-size: 0.67rem;
}

.invoice-hero__nav > b,
.invoice-hero__nav > span {
  padding: 0.48rem 0.55rem;
  border-radius: 0.45rem;
  font-style: normal;
}

.invoice-hero__nav span {
  display: flex;
  justify-content: space-between;
  color: #6d635b;
}

.invoice-hero__nav i {
  font-style: normal;
}

.invoice-hero__nav .is-active {
  background: #e6e1d7;
  color: #c94d20;
  font-weight: 750;
}

.invoice-hero__nav .is-child {
  margin-left: 0.5rem;
}

.invoice-hero__account {
  margin-top: auto;
  color: #2d2825 !important;
  font-weight: 750;
}

.invoice-hero__list {
  background: #fff;
  font-size: 0.68rem;
}

.invoice-hero__search {
  margin: 0.75rem;
  padding: 0.55rem 0.65rem;
  border-radius: 999px;
  background: #f1eeeb;
  color: #8c827a;
}

.invoice-hero__list > small {
  display: block;
  padding: 0.3rem 0.85rem 0.45rem;
  color: #756a63;
}

.invoice-hero__list article {
  padding: 0.75rem 0.85rem;
  border-bottom: 1px solid #eee9e5;
}

.invoice-hero__list article b,
.invoice-hero__list article span,
.invoice-hero__list article em {
  display: block;
}

.invoice-hero__list article span {
  margin-top: 0.25rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.invoice-hero__list article em {
  margin-top: 0.3rem;
  color: #bd691d;
  font-style: normal;
  font-weight: 750;
}

.invoice-hero__list .is-selected {
  border-left: 3px solid #d65a24;
  background: #e9f4fb;
}

.invoice-hero__reader {
  display: grid;
  grid-template-rows: auto auto 1fr;
  min-width: 0;
}

.invoice-hero__reader-tools {
  padding: 0.85rem 1rem;
  border-bottom: 1px solid #ebe6e1;
}

.invoice-hero__reader header {
  padding: 0.9rem 1.1rem;
  border-bottom: 1px solid #ebe6e1;
}

.invoice-hero__reader h3 {
  margin: 0;
  font-family: Georgia, "Noto Serif SC", serif;
  font-size: 1rem;
}

.invoice-hero__reader header p {
  margin: 0.3rem 0 0;
  color: #81776f;
  font-size: 0.68rem;
}

.invoice-hero__mail-body {
  padding: 1.8rem 2.1rem;
  font-family: Georgia, "Noto Serif SC", serif;
  font-size: 0.72rem;
  line-height: 1.8;
}

.invoice-hero__mail-body dl {
  display: grid;
  grid-template-columns: 1fr 1fr;
  margin-top: 1.3rem;
  border: 1px solid #e8e3de;
  font-family: Inter, "Noto Sans SC", sans-serif;
}

.invoice-hero__mail-body dl div {
  padding: 0.7rem;
  text-align: center;
}

.invoice-hero__mail-body dl div + div {
  border-left: 1px solid #e8e3de;
}

.invoice-hero__mail-body dt {
  font-weight: 750;
}

.invoice-hero__mail-body dd {
  margin: 0.45rem 0 0;
}

.invoice-hero__ai {
  position: relative;
  min-width: 0;
  margin: 0.55rem 0.45rem 0.45rem 0;
  overflow: hidden;
  border: 1px solid #e6e0db;
  border-radius: 1.4rem;
  background: #fbfaf8;
}

.invoice-hero__ai > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem;
}

.invoice-hero__ai h3 {
  margin: 0;
  font-size: 1rem;
}

.invoice-hero__ai > header span {
  color: #8e847c;
  font-size: 0.7rem;
}

.invoice-hero__ai-body {
  position: absolute;
  inset: 3.4rem 0 4.8rem;
  padding: 0 0.9rem;
}

.invoice-hero__prompt {
  margin-left: 1.4rem;
  padding: 0.75rem;
  border-radius: 1rem 1rem 0.3rem 1rem;
  background: #d66748;
  color: #fff;
  font-size: 0.66rem;
  font-weight: 700;
  line-height: 1.55;
}

.invoice-hero__analysis,
.invoice-hero__confirmation,
.invoice-hero__success {
  margin-top: 0.75rem;
  padding: 0.75rem;
  border: 1px solid #e4ded9;
  border-radius: 0.85rem;
  background: #fff;
  font-size: 0.65rem;
}

.invoice-hero__analysis > p {
  color: #756a63;
}

.invoice-hero__analysis ol {
  display: grid;
  gap: 0.45rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.invoice-hero__analysis li {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.5rem;
  border: 1px solid #ebe5e0;
  border-radius: 0.65rem;
}

.invoice-hero__analysis li > span {
  display: grid;
  place-items: center;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 50%;
  background: #edf7f0;
  color: #39805a;
}

.invoice-hero__analysis li b,
.invoice-hero__analysis li small {
  display: block;
}

.invoice-hero__analysis li small {
  margin-top: 0.15rem;
  color: #91877f;
}

.invoice-hero__confirmation {
  position: absolute;
  right: 0.9rem;
  bottom: 0.8rem;
  left: 0.9rem;
  border-color: #d99c43;
}

.invoice-hero__confirmation > small {
  display: inline-flex;
  padding: 0.2rem 0.45rem;
  border-radius: 999px;
  background: #fff0d6;
  color: #ad681b;
  font-weight: 800;
}

.invoice-hero__confirmation > b,
.invoice-hero__confirmation > p {
  display: block;
  margin-top: 0.45rem;
}

.invoice-hero__confirmation > div {
  display: flex;
  justify-content: end;
  gap: 0.4rem;
  margin-top: 0.6rem;
}

.invoice-hero__confirmation button {
  padding: 0.35rem 0.6rem;
  border: 1px solid #ddd5cf;
  border-radius: 0.4rem;
  background: #fff;
}

.invoice-hero__confirmation button:last-child {
  border-color: #647a36;
  background: #647a36;
  color: #fff;
}

.invoice-hero__pointer {
  position: absolute;
  right: 1.1rem;
  bottom: 1rem;
  color: #2d2825;
  transform: rotate(-35deg);
}

.invoice-hero__success {
  position: absolute;
  right: 0.9rem;
  bottom: 0.8rem;
  left: 0.9rem;
  border-color: #b9d8c3;
  background: #f3fbf5;
  color: #275f3f;
}

.invoice-hero__success b,
.invoice-hero__success span {
  display: block;
}

.invoice-hero__success span {
  margin-top: 0.35rem;
}

.invoice-hero__composer {
  position: absolute;
  right: 0.8rem;
  bottom: 0.65rem;
  left: 0.8rem;
  min-height: 3.4rem;
  padding: 0.8rem;
  border: 1px solid #ddd6d0;
  border-radius: 1rem;
  background: #fff;
  color: #8a8077;
  font-size: 0.68rem;
}

[data-invoice-scene] {
  opacity: 0;
  transform: translateY(0.6rem);
}

[data-animation-state="complete"] .invoice-hero__success {
  opacity: 1;
  transform: none;
}

[data-animation-state="complete"] .invoice-hero__prompt,
[data-animation-state="complete"] .invoice-hero__analysis,
[data-animation-state="complete"] .invoice-hero__confirmation {
  display: none;
}

[data-animation-state="playing"].is-replaying .invoice-hero__prompt,
[data-animation-state="paused"].is-replaying .invoice-hero__prompt {
  animation: invoice-prompt 12s ease-in-out infinite both;
}

[data-animation-state="playing"].is-replaying .invoice-hero__analysis,
[data-animation-state="paused"].is-replaying .invoice-hero__analysis {
  animation: invoice-analysis 12s ease-in-out infinite both;
}

[data-animation-state="playing"].is-replaying .invoice-hero__confirmation,
[data-animation-state="paused"].is-replaying .invoice-hero__confirmation {
  animation: invoice-confirmation 12s ease-in-out infinite both;
}

[data-animation-state="playing"].is-replaying .invoice-hero__pointer,
[data-animation-state="paused"].is-replaying .invoice-hero__pointer {
  animation: invoice-pointer 12s ease-in-out infinite both;
}

[data-animation-state="playing"].is-replaying .invoice-hero__success,
[data-animation-state="paused"].is-replaying .invoice-hero__success {
  animation: invoice-success 12s ease-in-out infinite both;
}

[data-animation-state="paused"] [data-invoice-scene],
[data-animation-state="paused"] .invoice-hero__pointer {
  animation-play-state: paused;
}

@keyframes invoice-prompt {
  0%, 6% { opacity: 0; transform: translateY(0.6rem); }
  12%, 92% { opacity: 1; transform: none; }
  100% { opacity: 0; transform: none; }
}

@keyframes invoice-analysis {
  0%, 18% { opacity: 0; transform: translateY(0.6rem); }
  25%, 58% { opacity: 1; transform: none; }
  65%, 100% { opacity: 0; transform: translateY(-0.3rem); }
}

@keyframes invoice-confirmation {
  0%, 48% { opacity: 0; transform: translateY(0.7rem); }
  56%, 74% { opacity: 1; transform: none; }
  81%, 100% { opacity: 0; transform: translateY(-0.3rem); }
}

@keyframes invoice-pointer {
  0%, 61% { opacity: 0; transform: translate(1.1rem, 1rem) rotate(-35deg); }
  67% { opacity: 1; transform: rotate(-35deg); }
  72% { opacity: 1; transform: translateY(0.2rem) scale(0.9) rotate(-35deg); }
  78%, 100% { opacity: 0; transform: translateY(0.2rem) rotate(-35deg); }
}

@keyframes invoice-success {
  0%, 75% { opacity: 0; transform: translateY(0.6rem); }
  82%, 94% { opacity: 1; transform: none; }
  100% { opacity: 0; transform: none; }
}

@media (max-width: 62rem) {
  .invoice-hero__workspace {
    grid-template-columns: minmax(12rem, 0.8fr) minmax(18rem, 1.2fr);
  }

  .invoice-hero__nav,
  .invoice-hero__reader {
    display: none;
  }

  .invoice-hero__viewport {
    min-height: 31rem;
  }

  .invoice-hero__list article:not(.is-selected) {
    display: none;
  }

  [data-invoice-scene] {
    animation: none !important;
  }

  .invoice-hero__prompt,
  .invoice-hero__analysis,
  .invoice-hero__confirmation,
  .invoice-hero__pointer {
    display: none;
  }

  .invoice-hero__success {
    opacity: 1 !important;
    transform: none !important;
  }
}

@media (max-width: 42rem) {
  .invoice-hero__toolbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .invoice-hero__workspace {
    grid-template-columns: 1fr;
  }

  .invoice-hero__list {
    border-right: 0;
    border-bottom: 1px solid #e9e3de;
  }

  .invoice-hero__ai {
    min-height: 20rem;
    margin: 0.45rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-invoice-scene],
  .invoice-hero__pointer {
    animation: none !important;
  }

  .invoice-hero__prompt,
  .invoice-hero__analysis,
  .invoice-hero__confirmation,
  .invoice-hero__pointer {
    display: none;
  }

  .invoice-hero__success {
    opacity: 1 !important;
    transform: none !important;
  }
}
```

- [ ] **Step 5: Run component contract tests, Astro check, and all unit tests**

Run:

```powershell
node --test --test-name-pattern="invoice hero contains|invoice hero CSS" website/tests/invoice-hero-markup.test.mjs
npm --prefix website run check
npm --prefix website test
```

Expected: component tests PASS, Astro check reports no errors, and all unit tests PASS.

- [ ] **Step 6: Commit the component and animation styles**

```powershell
git add website/src/components/landing/InvoiceHeroDemo.astro website/src/styles/invoice-hero.css website/tests/invoice-hero-markup.test.mjs website/package.json
git commit -m "feat(docs): add real app invoice hero scene"
```

---

### Task 5: Integrate the invoice hero and remove the three landing demos

**Files:**
- Modify: `website/tests/build-output.test.mjs`
- Modify: `website/src/components/landing/Hero.astro`
- Modify: `website/src/components/landing/SiteHeader.astro`
- Modify: `website/src/layouts/LandingLayout.astro`
- Modify: `website/src/pages/index.astro`
- Modify: `website/src/styles/landing.css`
- Delete: `website/src/components/demos/ActionLoopDemo.astro`

**Interfaces:**
- Consumes: `INSTALL_LINK_ATTRIBUTES` from Task 1.
- Consumes: `InvoiceHeroDemo` and `invoice-hero.css` from Task 4.
- Preserves: existing `FeatureCard`, exploration section, security callout, footer, and Starlight feature-page demos.

- [ ] **Step 1: Replace the landing build-output test with the new acceptance contract**

In `website/tests/build-output.test.mjs`, replace the first test with:

```javascript
test("landing page contains one real-app invoice hero and no product demo grid", async () => {
  const html = await readFile(path.join(projectRoot, "dist", "index.html"), "utf8");
  assert.match(html, /<html[^>]+lang="zh-CN"/);
  assert.match(html, /让邮件里的工作，自动向前一步/);
  assert.match(html, /<figure[^>]+data-invoice-hero/);
  assert.match(html, /WeMail AI/);
  assert.match(html, /上传 1 个 PDF 发票附件到发票平台/);
  assert.match(html, /上传完成：成功 1 个，失败 0 个/);
  assert.doesNotMatch(html, /id="highlights"/);
  assert.doesNotMatch(html, /产品亮点/);
  assert.equal((html.match(/<figure[^>]+data-feature-demo/g) ?? []).length, 0);
  assert.match(html, /探索能力/);
  assert.match(html, /本地优先，边界清晰/);
  assert.equal(
    (html.match(/href="\/getting-started\/install\/"/g) ?? []).length,
    2,
  );
});
```

- [ ] **Step 2: Run the production build test and verify the old landing page fails**

Run:

```powershell
npm --prefix website run test:build
```

Expected: FAIL because the current landing output still has `id="highlights"`, three `data-feature-demo` figures, and no `data-invoice-hero`.

- [ ] **Step 3: Replace the static hero with the shared link and invoice component**

Replace `website/src/components/landing/Hero.astro` with:

```astro
---
import { INSTALL_LINK_ATTRIBUTES } from "../../config/site-links.mjs";
import InvoiceHeroDemo from "./InvoiceHeroDemo.astro";
---

<section class="hero">
  <p class="hero__eyebrow">Local-first AI Mail</p>
  <h1>让邮件里的工作，自动向前一步</h1>
  <p class="hero__copy">WeMail 在一个本地优先的 Windows 工作台中理解邮件、整理发票，并通过安全的本地 MCP 连接你的 AI 工具。</p>
  <div class="hero__actions">
    <a class="button button--primary" {...INSTALL_LINK_ATTRIBUTES}>安装 WeMail</a>
    <a class="button button--secondary" href="/getting-started/overview/">阅读文档</a>
  </div>
  <InvoiceHeroDemo />
</section>
```

- [ ] **Step 4: Update the header navigation and shared install link**

Replace `website/src/components/landing/SiteHeader.astro` with:

```astro
---
import { INSTALL_LINK_ATTRIBUTES } from "../../config/site-links.mjs";
---

<header class="site-header">
  <a class="site-header__brand" href="/" aria-label="WeMail 首页">
    <img src="/favicon.svg" width="32" height="32" alt="" />
    <span>WeMail</span>
  </a>
  <nav aria-label="主要导航">
    <a href="/getting-started/overview/">使用指南</a>
    <a href="/features/mcp/">MCP</a>
    <a class="site-header__button" {...INSTALL_LINK_ATTRIBUTES}>开始使用</a>
  </nav>
</header>
```

- [ ] **Step 5: Remove the landing demo imports and complete highlights section**

Replace `website/src/pages/index.astro` with:

```astro
---
import FeatureCard from "../components/landing/FeatureCard.astro";
import Hero from "../components/landing/Hero.astro";
import SiteHeader from "../components/landing/SiteHeader.astro";
import LandingLayout from "../layouts/LandingLayout.astro";
---

<LandingLayout title="WeMail 官方文档" description="WeMail 本地优先智能邮件客户端官方文档">
  <SiteHeader />
  <main>
    <Hero />
    <section class="section">
      <div class="section__heading">
        <span>探索能力</span>
        <h2>按你的工作方式进入 WeMail</h2>
      </div>
      <div class="feature-grid">
        <FeatureCard eyebrow="AI" title="摘要、草稿与智能标签" description="理解单封邮件和完整会话，把重要信息变成可以继续处理的结果。" href="/features/ai/" />
        <FeatureCard eyebrow="Invoice" title="发票邮件工作流" description="集中查看发票附件及其上传、失败或关联状态。" href="/features/invoices/" />
        <FeatureCard eyebrow="MCP" title="让本地 AI 工具调用邮箱" description="通过可撤销 Token、有界结果和确认策略控制能力边界。" href="/features/mcp/" />
      </div>
    </section>
    <section class="section">
      <div class="security-callout">
        <div>
          <h2>本地优先，边界清晰</h2>
          <p>邮箱凭据、MCP Token 和真实邮件内容不应出现在文档、日志、截图或测试示例中。</p>
        </div>
        <a class="button button--secondary" href="/security/privacy/">查看安全模型</a>
      </div>
    </section>
  </main>
  <footer class="site-footer">WeMail 官方文档 · Apache-2.0</footer>
</LandingLayout>
```

After replacing `index.astro`, delete `website/src/components/demos/ActionLoopDemo.astro`. No remaining source imports that component; retain `InvoiceDemo.astro`, `McpDemo.astro`, `FeatureDemo.astro`, `feature-demo.mjs`, and `feature-demos.css` for Starlight feature pages.

- [ ] **Step 6: Import invoice styles and remove landing-only demo styles**

Replace the imports at the top of `website/src/layouts/LandingLayout.astro` with:

```astro
---
import "../styles/landing.css";
import "../styles/invoice-hero.css";

interface Props {
  title: string;
  description: string;
}

const { title, description } = Astro.props;
---
```

Do not remove `./src/styles/feature-demos.css` from `website/astro.config.mjs`; Starlight feature pages still require it.

- [ ] **Step 7: Remove obsolete static-hero and demo-grid rules from landing CSS**

In `website/src/styles/landing.css`, use `apply_patch` to delete every complete rule whose selector is listed below, including all declarations inside each block:

```text
.hero__window
.hero__rail
.hero__rail i
.hero__rail i.active
.hero__list
.hero__list span
.hero__list span:first-child
.hero__message
.hero__message > span
.hero__message > span:nth-child(3)
.hero__message > div
.demo-grid
```

Replace the `@media (max-width: 62rem)` selector list and content with:

```css
@media (max-width: 62rem) {
  .feature-grid {
    grid-template-columns: 1fr;
  }
}
```

Remove both `.hero__window` mobile blocks from `@media (max-width: 42rem)`. Keep the header and security-callout rules unchanged.

Add after `.hero__actions`:

```css
.hero > .invoice-hero {
  text-align: left;
}
```

- [ ] **Step 8: Run focused tests and production verification**

Run:

```powershell
npm --prefix website test
npm --prefix website run check
npm --prefix website run test:build
```

Expected:

- all unit tests PASS;
- Astro check reports no errors;
- production build and build-output tests PASS;
- the landing output contains one invoice hero, no highlights section, no landing feature-demo figures, two shared install links, exploration cards, and the security callout.

- [ ] **Step 9: Inspect repository status and ensure unrelated files are not staged**

Run:

```powershell
git status --short
git diff --check
```

Expected: only the Task 5 website files are modified; `.codegraph/daemon.pid`, `.tmp-package-lock.json`, and `wemail-docs-local.tar` remain unstaged if they are still present.

- [ ] **Step 10: Commit the landing integration**

```powershell
git add website/tests/build-output.test.mjs website/src/components/landing/Hero.astro website/src/components/landing/SiteHeader.astro website/src/layouts/LandingLayout.astro website/src/pages/index.astro website/src/styles/landing.css website/src/components/demos/ActionLoopDemo.astro
git commit -m "feat(docs): replace landing demos with invoice hero"
```

- [ ] **Step 11: Run the final verification suite and push the completed branch**

Run:

```powershell
npm --prefix website test
npm --prefix website run check
npm --prefix website run test:build
git status --short
git push origin HEAD
```

Expected: all website checks PASS; only pre-existing unrelated working-tree files remain; the current branch is pushed successfully.
