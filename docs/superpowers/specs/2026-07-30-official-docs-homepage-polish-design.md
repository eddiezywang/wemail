# WeMail Official Documentation Homepage Polish Design

**Date:** 2026-07-30

## Summary

Polish the existing Astro and Starlight official documentation site so the landing page accurately reflects the current WeMail desktop application and updated brand. Replace the current static hero illustration with one full-width, accessible animation based on the real four-region WeMail workbench and invoice upload confirmation flow. Remove the three existing landing-page demonstration cards, repair low-contrast headings, centralize the installation link, and use the updated orange envelope logo throughout the website.

The animation is a documentation-only Astro, HTML, CSS, and small JavaScript reproduction. It does not import desktop React components, reuse application business logic, call backend APIs, or render real mailbox data.

## Goals

- Make the landing page hero visually consistent with the current WeMail desktop application.
- Demonstrate the real invoice workflow: AI analysis, tool progress, explicit user confirmation, and a successful upload result.
- Replace multiple small landing-page animations with one clear, full-width product narrative.
- Restore readable title colors across the landing page and Starlight documentation pages.
- Apply the updated WeMail orange envelope logo consistently to all website brand surfaces.
- Keep the future installer target configurable without changing multiple components.
- Preserve static readability, accessibility, and useful fallbacks when animation or JavaScript is unavailable.

## Non-goals

- Adding a release-history or historical-versions page.
- Adding release-history links to the landing navigation or documentation sidebar.
- Importing React renderer components, Tailwind styles, desktop state, or Electron APIs into `website/`.
- Calling the local API, reading a mailbox, uploading a real invoice, or connecting to an invoice platform from the documentation site.
- Recording or embedding a video, GIF, canvas animation, or external media asset for the hero.
- Redesigning documentation content unrelated to the requested homepage, branding, title contrast, or installation link.

## Current-State Findings

- `website/src/pages/index.astro` currently renders a hero followed by three independent demonstration cards for invoices, MCP, and email-to-action workflows.
- `website/src/components/landing/Hero.astro` currently contains a static three-column placeholder rather than a real product interaction.
- The landing-page header uses the website favicon instead of the canonical desktop brand asset.
- The remote `main` branch introduced the updated canonical logo at `electron/assets/wemail-icon.svg`, with matching generated application assets.
- Starlight renders Markdown headings with `--sl-color-white`. The current light-theme override sets that variable to `#fffaf7`, which is close to the page background and causes headings to appear nearly transparent.
- The website has no external installer URL yet. Existing installation calls to action route to `/getting-started/install/`.

## Approved Landing-Page Structure

The landing page retains its existing product narrative while simplifying the animation hierarchy:

1. The sticky site header contains the updated logo, the existing guide and MCP links, and the existing start action.
2. The hero retains its eyebrow, title, description, installation action, and documentation action.
3. The current static hero window is replaced by one full-width invoice workflow animation.
4. The complete `产品亮点` section and its three demonstration cards are removed from the landing page.
5. The existing `探索能力` cards remain.
6. The existing local-first and security callout remains.
7. The footer remains.

Removing the landing-page demonstrations means removing their imports and render path from `index.astro`. Dedicated demo files or shared animation styles should only be deleted when they have no remaining documentation-page consumers.

## Component Boundaries

### Landing Hero

`Hero.astro` owns only the hero copy, calls to action, and placement of the product demonstration. It delegates the visual workflow to a dedicated component rather than containing the complete animation markup.

### Invoice Hero Demonstration

A focused Astro component, such as `InvoiceHeroDemo.astro`, owns:

- the four-region product scene;
- anonymous example mail and invoice content;
- the visual states for analysis, confirmation, and completion;
- pause and replay controls;
- concise accessible descriptions of the demonstrated workflow.

The component contains no application API integration or domain behavior. Its interface is presentation-only and does not expose mailbox identifiers, invoice records, credentials, or upload functions.

### Animation Controller

A small website-local controller owns playback enhancement:

- automatic loop startup;
- hover pause and resume;
- replay from the first scene;
- page-visibility pause and resume;
- cleanup of event listeners when the page is unloaded;
- reduced-motion detection.

The meaningful final scene is present in HTML before client enhancement. CSS controls the visual timeline; JavaScript controls playback state rather than imperatively rebuilding every frame.

### Site Links

A single website-local configuration value owns the installation destination. Both landing-page installation actions read the same value. Its initial value is `/getting-started/install/`. A later installer or release URL can replace it in one location.

## Hero Visual Layout

The approved hero demonstration reproduces the current desktop application's visible information architecture, based on the user-provided WeMail screenshots:

1. A compact native-style title bar with the updated WeMail logo and product name.
2. A warm-gray left navigation rail containing compose, mailbox, task, application-message, contact, and smart-tag entries.
3. A message-list column with a selected invoice email and invoice status label.
4. A message-reading column showing an invoice email and bounded example invoice details.
5. A rounded `WeMail AI` panel on the right showing analysis, tool execution, confirmation, and completion states.

The scene occupies one full row at the landing page's maximum content width. Desktop rendering preserves the four regions horizontally rather than squeezing the demonstration into a small card. Proportions should follow the real application approximately: a narrow navigation rail, a medium message list, a large message reader, and a substantial AI panel.

All example addresses, account names, invoice identifiers, amounts, and attachment names are anonymous or fictional. The scene follows the real layout and labels without copying mailbox data from the reference screenshots into production assets.

## Approved Animation Sequence

The animation runs for approximately ten to twelve seconds and then loops after a short completed-state pause.

1. **Select invoice mail:** The invoice message is visibly selected in the mail list while the corresponding message body is open.
2. **Request analysis:** The WeMail AI panel shows a prompt to inspect the current email for invoice attachments or invoice information and prepare an upload confirmation.
3. **Show tool progress:** The panel reveals tool steps matching the real interface, including reading the email, processing the attachment, and preparing a confirmation action.
4. **Request confirmation:** A bordered `需要确认` card appears for `上传 1 个 PDF 发票附件到发票平台`, with `拒绝` and `确认` actions.
5. **Confirm:** A decorative pointer moves to the confirmation action and visually activates it.
6. **Complete successfully:** The confirmation card transitions to an execution result stating that one invoice attachment uploaded successfully and zero failed.

The animation must preserve the product's human-confirmation boundary. It must not imply that WeMail uploads invoices before the user confirms.

## Playback and Interaction Rules

- Begin automatic playback when the hero is ready.
- Loop continuously with a readable pause on the successful final state.
- Pause while the pointer is over the demonstration and resume when it leaves.
- Provide a native replay button with a visible focus state and Chinese accessible name.
- Pause when `document.visibilityState` is not `visible`; resume according to the previous playback state when the page becomes visible again.
- Do not announce each decorative animation frame to assistive technology. Provide a concise static description of the sequence.
- Treat the animated pointer as decorative and hide it from assistive technology.
- Do not make the animation the only source of information about the invoice workflow.

## Responsive and Reduced-Motion Behavior

### Desktop

At the landing page's normal desktop widths, the full product demonstration fills one horizontal row and preserves all four visible application regions.

### Narrow Screens

The complete four-region application must not be compressed until labels and actions become unreadable. At narrow breakpoints, replace the moving timeline with a simplified static completed-state composition that prioritizes:

- the selected invoice mail;
- the `WeMail AI` confirmation boundary;
- the successful upload result.

The public page must not require horizontal scrolling to understand the hero.

### Reduced Motion

When `prefers-reduced-motion: reduce` is active:

- disable automatic timeline transitions, scanning sweeps, pulsing, and pointer movement;
- show a meaningful final success state;
- retain usable replay or pause controls only if their action remains meaningful;
- preserve all text and confirmation context.

## Branding and Logo Consistency

`electron/assets/wemail-icon.svg` is the canonical brand reference. The documentation site remains independently buildable with `website/` as its Docker context, so it keeps website-local copies for Astro imports and public favicon delivery.

The implementation updates:

- the landing-page site header logo;
- the Starlight documentation header logo;
- the SVG favicon and any required raster favicon output.

Add a focused consistency test or deterministic synchronization check so website-local brand copies cannot silently diverge from the canonical SVG. The check compares source content or normalized generated output without introducing a runtime dependency on files outside `website/`.

## Title Color System

The light-theme Starlight palette must preserve Starlight's semantic variable expectations:

- `--sl-color-white` represents the darkest heading and strong foreground in light mode rather than the page background.
- `--sl-color-black` remains the light page surface in light mode.
- gray variables form a readable dark-to-light foreground and surface scale.

Landing-page and documentation title treatment:

- `h1`, `h2`, and `h3` use solid dark brown-black foreground colors.
- Documentation sidebar group headings use a softer dark gray that remains clearly readable.
- Coral or saddle orange is reserved for eyebrow labels, links, active navigation, and status emphasis.
- Opacity is not applied to primary headings.
- Light and dark themes maintain adequate contrast against their surfaces.

The implementation should fix the theme variables at the source instead of adding isolated `!important` overrides to individual documentation headings.

## Installation Link Configuration

The current installation experience remains the curated installation guide. A single exported value provides the target:

```text
INSTALL_URL = "/getting-started/install/"
```

The landing hero installation action and header start action both consume this value. When the value later becomes an external installer URL, the link renderer adds the appropriate external-link attributes, including a safe `rel` value when a new browsing context is used.

No empty `href`, `#` placeholder, or broken download URL is introduced.

## Error Handling and Static Degradation

- The hero demonstration performs no runtime network request and therefore has no mailbox, AI-provider, or upload error path.
- If JavaScript does not load, the HTML and CSS show a complete, meaningful final state.
- If animation features are unsupported, the static layout remains readable.
- If website-local logo assets are missing or inconsistent, automated checks fail before deployment rather than silently falling back to the old temporary logo.
- If the installation configuration is empty or invalid, a focused test fails; the rendered site must always have a valid internal or HTTPS target.
- Animation setup must be idempotent so client-side enhancement cannot register duplicate visibility or pointer listeners.

## Testing Strategy

### Landing Structure

- Assert that the landing page no longer renders the `产品亮点` section.
- Assert that the invoice, MCP, and email-to-action demonstration cards are absent from the landing-page output.
- Assert that the hero contains the dedicated invoice demonstration.
- Assert that the existing exploration and security sections remain.

### Animation Markup and Behavior

- Verify the scene contains the navigation, message list, message reader, and `WeMail AI` regions.
- Verify the scene contains analysis steps, a visible confirmation boundary, and the successful `1` uploaded / `0` failed result.
- Verify automatic playback, hover pause, resume, replay, and page-visibility behavior.
- Verify listeners are cleaned up and enhancement is not duplicated.
- Verify reduced-motion mode exposes a meaningful completed static state.
- Verify the no-JavaScript build output contains usable final-state content.

### Branding and Colors

- Verify the landing header, Starlight logo, and favicon use the updated orange envelope artwork.
- Verify website-local logo copies match the canonical project logo through the approved consistency check.
- Verify the light-theme Starlight heading variable resolves to a dark foreground rather than an off-white surface color.
- Verify representative landing and documentation headings meet the intended contrast requirements.

### Installation Links

- Verify both installation actions use the shared configuration target.
- Verify the initial target is `/getting-started/install/`.
- Verify internal and future external URL rendering applies the correct attributes.

### Production Verification

Run the website's focused tests, Astro check, and production build tests. Representative built pages must include the revised landing page, readable documentation titles, updated brand assets, and valid installation links.

## Acceptance Criteria

- The landing page contains one full-width invoice workflow animation based on the real WeMail application layout.
- The animation shows AI analysis, tool progress, explicit user confirmation, and a successful upload of one invoice attachment.
- The animation loops automatically, pauses on hover and page invisibility, supports replay, and honors reduced-motion preferences.
- The complete `产品亮点` section and its three landing-page demonstration cards are absent.
- The `探索能力` and local-first security sections remain.
- Landing-page and documentation headings are clearly readable in light and dark themes.
- The landing header, Starlight header, and favicon use the updated orange envelope logo.
- Website-local brand assets cannot silently diverge from the canonical project logo.
- Both installation actions currently route to `/getting-started/install/` through one shared configuration value.
- The website remains independently buildable and deployable without importing desktop application code or accessing real mailbox data.
- No release-history page or navigation entry is added.
