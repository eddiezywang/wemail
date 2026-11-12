# Official Documentation Follow-up Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the confirmed follow-up refinements to the WeMail documentation homepage, animation controls, installer delivery path, typography, and mailbox connection guide.

**Architecture:** Keep `website/` independently buildable and preserve the existing presentation-only animation architecture. Remove visible manual animation controls while retaining automatic viewport/page/reduced-motion safeguards, centralize both installer CTAs on a deploy-replaceable static artifact, and express documentation changes through Starlight theme overrides and Markdown content.

**Tech Stack:** Astro 5.18, Starlight 0.37, semantic HTML, CSS, browser DOM APIs, Node 22 `node:test`.

## Global Constraints

- The desktop invoice application viewport keeps its current width and uses `aspect-ratio: 16 / 9` at widths above `62rem`.
- Below `62rem`, the existing readable auto-height static layout remains; do not force 16:9.
- Remove every visible pause/replay control from the homepage invoice animation and the invoice/MCP documentation demos.
- Automatic looping remains; retain hover pause for the homepage, viewport/page-background pausing, and reduced-motion completed fallbacks.
- Both homepage install CTAs use `/downloads/WeMail-Setup.exe`.
- `website/public/downloads/WeMail-Setup.exe` is a zero-byte placeholder copied to `/app/dist/downloads/WeMail-Setup.exe`; deployment replaces it with the real installer.
- Starlight document heading sizes are `h1: 24px`, `h2: 20px`, `h3: 18px` in both themes and at all viewport sizes.
- “真实 App 发票流程” uses the same visual label format as “探索能力”.
- The security-card action continues to read “查看安全模型” and must render dark readable text on its white background.
- The mailbox guide documents only provider settings supported by `shared/wemail/providers.ts`.
- Do not add a history/releases page or remove retained invoice/MCP documentation demonstrations.

---

### Task 1: Installer artifact and homepage style contracts

**Files:**
- Create: `website/public/downloads/WeMail-Setup.exe`
- Modify: `website/src/config/site-links.mjs`
- Modify: `website/tests/site-links.test.mjs`
- Modify: `website/tests/build-output.test.mjs`
- Modify: `website/tests/invoice-hero-markup.test.mjs`
- Modify: `website/src/styles/landing.css`
- Modify: `website/src/styles/invoice-hero.css`

**Interfaces:**
- Produces: `INSTALL_URL === "/downloads/WeMail-Setup.exe"`.
- Produces: a zero-byte public artifact copied unchanged to the built site.
- Produces: desktop invoice viewport `aspect-ratio: 16 / 9` with a `max-width: 62rem` override to `aspect-ratio: auto`.

- [ ] **Step 1: Write failing installer and visual contract tests**

Update the site-link test to expect:

```javascript
assert.equal(INSTALL_URL, "/downloads/WeMail-Setup.exe");
assert.deepEqual(INSTALL_LINK_ATTRIBUTES, {
  href: "/downloads/WeMail-Setup.exe",
});
```

Extend the build-output test to assert both installer links use the new path and that `dist/downloads/WeMail-Setup.exe` exists with `size === 0`.

Extend the invoice markup/style test to assert:

```javascript
assert.match(css, /\.invoice-hero__viewport\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/s);
assert.match(css, /@media \(max-width: 62rem\)[\s\S]*\.invoice-hero__viewport\s*\{[^}]*aspect-ratio:\s*auto/s);
assert.match(css, /\.invoice-hero__eyebrow[\s\S]*font-size:\s*1rem/);
```

Add a landing CSS assertion that `.security-callout .button--secondary` has an explicit dark color.

- [ ] **Step 2: Run RED**

Run:

```powershell
node --test website/tests/site-links.test.mjs website/tests/invoice-hero-markup.test.mjs
npm --prefix website run test:build
```

Expected: FAIL on the old install path, absent placeholder, absent 16:9 contract, mismatched eyebrow format, and missing security-button foreground.

- [ ] **Step 3: Implement minimal production changes**

- Change `INSTALL_URL` to `/downloads/WeMail-Setup.exe`.
- Add the zero-byte public installer placeholder.
- Set the desktop `.invoice-hero__viewport` to `aspect-ratio: 16 / 9; overflow: hidden;` without changing its width.
- In the `max-width: 62rem` block, restore `aspect-ratio: auto`.
- Match `.invoice-hero__eyebrow` to `.section__heading span`: `color: #c9513d; font-size: 1rem; font-weight: 800; letter-spacing: normal; text-transform: none`.
- Add `.security-callout .button--secondary { color: #2d2825; }`.

- [ ] **Step 4: Run GREEN and commit**

Run focused tests and `npm --prefix website run test:build`, then commit:

```powershell
git add website/public/downloads/WeMail-Setup.exe website/src/config/site-links.mjs website/src/styles/landing.css website/src/styles/invoice-hero.css website/tests/site-links.test.mjs website/tests/build-output.test.mjs website/tests/invoice-hero-markup.test.mjs
git commit -m "fix(docs): refine homepage canvas and installer link"
```

---

### Task 2: Remove the homepage invoice replay control

**Files:**
- Modify: `website/src/components/landing/InvoiceHeroDemo.astro`
- Modify: `website/src/scripts/invoice-hero.mjs`
- Modify: `website/src/styles/invoice-hero.css`
- Modify: `website/tests/invoice-hero.test.mjs`
- Modify: `website/tests/invoice-hero-markup.test.mjs`

**Interfaces:**
- Preserves: `data-invoice-hero`, `data-animation-state`, hover pause, document visibility, bfcache restoration, and reduced-motion behavior.
- Removes: `data-invoice-hero-replay`, `data-replay-key`, replay events, and `.is-replaying` dependency.

- [ ] **Step 1: Write failing no-control/autoloop tests**

Assert the component has no `data-invoice-hero-replay`, no “重新播放”, and no `data-replay-key`. Update controller tests so state contains no replay key and the DOM harness exposes only the viewport. Assert CSS animations are selected directly by both playing and paused states, without `.is-replaying`.

- [ ] **Step 2: Run RED**

Run:

```powershell
node --test website/tests/invoice-hero.test.mjs website/tests/invoice-hero-markup.test.mjs
```

Expected: FAIL because replay markup, state, events, and CSS selectors still exist.

- [ ] **Step 3: Implement minimal removal**

- Delete the replay button from `InvoiceHeroDemo.astro` and remove `data-replay-key` from the root figure.
- Remove replay state/events/DOM access from `invoice-hero.mjs`; keep hover, visibility, motion, pagehide/pageshow, cleanup, and enhancement idempotence.
- Replace selectors such as `[data-animation-state="playing"].is-replaying` with `[data-animation-state="playing"]`, while keeping paused animation rules so hover/background pausing freezes the current frame.

- [ ] **Step 4: Run GREEN and commit**

Run focused tests and the website unit suite, then commit:

```powershell
git add website/src/components/landing/InvoiceHeroDemo.astro website/src/scripts/invoice-hero.mjs website/src/styles/invoice-hero.css website/tests/invoice-hero.test.mjs website/tests/invoice-hero-markup.test.mjs
git commit -m "refactor(docs): remove invoice animation controls"
```

---

### Task 3: Remove documentation demo controls while preserving autoplay safeguards

**Files:**
- Modify: `website/src/components/demos/FeatureDemo.astro`
- Modify: `website/src/scripts/feature-demo.mjs`
- Modify: `website/src/styles/feature-demos.css`
- Modify: `website/tests/feature-demo.test.mjs`
- Modify: `website/tests/build-output.test.mjs`

**Interfaces:**
- Preserves: automatic looping while the demo is in the viewport and reduced-motion completed state.
- Removes: `data-demo-pause`, `data-demo-pause-label`, `data-demo-replay`, manual pause state, replay state, and visible control styling.

- [ ] **Step 1: Write failing control-removal tests**

Change reducer tests to cover only `VISIBILITY` and `REDUCED_MOTION`. Add source/build assertions that invoice and MCP pages still contain exactly one `data-feature-demo`, but contain zero pause/replay controls.

- [ ] **Step 2: Run RED**

Run:

```powershell
node --test website/tests/feature-demo.test.mjs
npm --prefix website run test:build
```

Expected: FAIL because controls and manual/replay state remain.

- [ ] **Step 3: Implement minimal removal**

- Remove the control container from `FeatureDemo.astro`.
- Simplify state to `{ visible, reducedMotion }`; `demoPhase` is playing only when visible and not reduced motion.
- Keep `IntersectionObserver` and motion-query enhancement; remove click listeners, manual pause, replay keys, and reflow restarts.
- Remove `.feature-demo__controls`/button CSS and redundant `.is-replaying` selectors.

- [ ] **Step 4: Run GREEN and commit**

Run focused tests, build-output tests, and commit:

```powershell
git add website/src/components/demos/FeatureDemo.astro website/src/scripts/feature-demo.mjs website/src/styles/feature-demos.css website/tests/feature-demo.test.mjs website/tests/build-output.test.mjs
git commit -m "refactor(docs): remove demo playback controls"
```

---

### Task 4: Compact documentation headings and expand mailbox support guidance

**Files:**
- Modify: `website/src/styles/custom.css`
- Modify: `website/tests/brand-theme.test.mjs`
- Modify: `website/src/content/docs/getting-started/connect-mailbox.md`
- Create: `website/tests/mailbox-docs.test.mjs`
- Modify: `website/package.json`

**Interfaces:**
- Produces: document heading sizes `24px`, `20px`, and `18px` for `h1`, `h2`, and `h3`.
- Produces: a provider table derived from `shared/wemail/providers.ts`.

- [ ] **Step 1: Write failing typography and content tests**

Extend `brand-theme.test.mjs` to require:

```javascript
assert.match(css, /--sl-text-h1:\s*1\.5rem/);
assert.match(css, /--sl-text-h2:\s*1\.25rem/);
assert.match(css, /--sl-text-h3:\s*1\.125rem/);
```

Create `mailbox-docs.test.mjs` that reads the guide and asserts all supported labels/hosts occur: corporate mail, 163, 126, QQ/Foxmail, Gmail, Outlook/Hotmail, iCloud, custom IMAP/SMTP, ports `993`, `465`, `587`, and authorization/app-password guidance. Register it in the explicit `npm test` script.

- [ ] **Step 2: Run RED**

Run:

```powershell
node --test website/tests/brand-theme.test.mjs website/tests/mailbox-docs.test.mjs
```

Expected: FAIL because heading overrides and the full provider table do not exist.

- [ ] **Step 3: Implement typography and documentation**

Add to `:root` in `custom.css`:

```css
--sl-text-h1: 1.5rem;
--sl-text-h2: 1.25rem;
--sl-text-h3: 1.125rem;
```

Repeat the same variables inside Starlight's desktop breakpoint if needed to prevent the upstream `min-width: 50em` override from restoring larger values.

Expand `connect-mailbox.md` with a table containing the exact preset hosts/ports/security modes and sections explaining authorization codes, app-specific passwords, custom servers, TLS, troubleshooting, and secret-handling boundaries.

- [ ] **Step 4: Run GREEN and commit**

Run focused tests, Astro check, and commit:

```powershell
git add website/src/styles/custom.css website/tests/brand-theme.test.mjs website/src/content/docs/getting-started/connect-mailbox.md website/tests/mailbox-docs.test.mjs website/package.json
git commit -m "docs: expand mailbox setup guidance"
```

---

### Task 5: Full verification, browser demonstration, and push

**Files:**
- Verify all files changed by Tasks 1–4.

- [ ] **Step 1: Run complete verification**

Run with `NPM_CONFIG_SCRIPT_SHELL=C:\Windows\System32\cmd.exe`:

```powershell
npm --prefix website run test:all
git diff --check
```

Expected: all unit/source tests pass, Astro reports zero diagnostics, production build succeeds, and all build-output tests pass.

- [ ] **Step 2: Verify built installer and homepage contracts**

Confirm:

- `website/dist/downloads/WeMail-Setup.exe` exists and is zero bytes.
- Built homepage contains two `/downloads/WeMail-Setup.exe` links.
- Built pages contain no pause/replay controls.
- Homepage contains one invoice hero, readable security action text, and retained exploration/security sections.

- [ ] **Step 3: Browser smoke test**

Refresh the existing `http://127.0.0.1:4322/` development server and inspect desktop plus a viewport below `62rem`. Confirm desktop 16:9, mobile readable auto-height, automatic loops, no visible controls, readable security button, consistent labels, and compact documentation headings.

- [ ] **Step 4: Commit any verification-only test refinements and push**

```powershell
git push origin feature/official-docs-homepage-polish
```

Expected: remote head matches local head.
