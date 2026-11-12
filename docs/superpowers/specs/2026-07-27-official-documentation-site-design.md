# WeMail Official Documentation Site Design

**Date:** 2026-07-27

## Summary

Build a curated, public-facing WeMail documentation site as an independent project under `website/`. Astro 5 and Starlight compile Simplified Chinese Markdown and MDX into static files. A post-build export preserves the original Markdown and MDX under `dist/raw/` for direct HTTP access. A multi-stage Docker build places only the generated site and a small static server into a Node 22 runtime image.

The site uses a warm, restrained, product-led visual direction that matches the current desktop client. The landing page contains three accessible interface animations: AI invoice handling, local MCP usage, and an email-to-action workflow. Internal architecture notes, evaluation reports, reverse-engineering material, and other files under the repository-level `docs/` directory are not published automatically.

## Goals

- Provide a polished official documentation experience for prospective and current WeMail users.
- Keep the documentation project independently installable, buildable, testable, and containerizable from `website/`.
- Publish selected user documentation in Simplified Chinese, with product names and technical identifiers left in their canonical English forms where appropriate.
- Serve both rendered static documentation and directly accessible original Markdown or MDX.
- Demonstrate real product capabilities without relying on video, GIF files, external CDNs, or claims unsupported by the repository.
- Make all animations accessible, lightweight, and useful even when JavaScript or motion is disabled.

## Non-goals

- Mirroring every file currently stored under the repository-level `docs/` directory.
- Publishing internal design specifications, evaluation reports, reverse-engineering artifacts, or private environment instructions.
- Adding a documentation CMS, server-side rendering, user accounts, analytics, search services, or a database.
- Reusing the desktop renderer build or importing desktop application components into the documentation build.
- Reproducing the complete WeMail application in the browser.
- Adding English localization in the first release.

## Audience and Voice

The primary audiences are:

1. Windows users evaluating or installing WeMail.
2. Existing users learning AI, invoice, automation, and MCP features.
3. Developers and AI-tool users connecting a local MCP client.

Documentation is written in clear Simplified Chinese. Headings and explanations prioritize user outcomes and safety. Code, commands, configuration keys, protocol names, and stable product terminology remain in English when translation would reduce precision.

## Information Architecture

The initial public navigation contains the following groups:

### 首页

- Product positioning and value proposition.
- Primary calls to action for installation and quick start.
- Three feature demonstrations.
- Short security and local-first statement linked to the full security page.

### 开始使用

- WeMail introduction.
- Windows installation.
- Connecting an email account.
- Configuring an AI provider and model.
- Basic inbox, reading, composing, and search workflows.

### WeMail AI

- Email and thread summaries.
- Action items and todos.
- Smart reply and draft generation.
- Smart tags and feedback-driven refinement.
- Agent and automation behavior.

### 发票助手

- Supported invoice-mail and attachment flow.
- Invoice detection and extracted information.
- Platform status meanings.
- User-authorized upload flow.
- Failure states and retry guidance.

### MCP

- Enabling the opt-in local MCP service.
- Creating and protecting the one-time token.
- Connecting compatible local clients.
- Read, draft, attachment, todo, and other supported tool categories.
- Confirmation requirements and risk boundaries for write operations.
- Rotation, revocation, logout, disablement, and session termination behavior.

### 安全与隐私

- Local-first storage model.
- Mailbox and provider credentials.
- Bounded AI context and user-controlled providers.
- MCP loopback binding and bearer-token handling.
- Confirmation, audit, and recovery principles.

### 帮助

- Troubleshooting.
- Frequently asked questions.
- Version and support information.

## Visual Design

The landing page uses the approved **Product Narrative** direction:

- Warm off-white surfaces, dark ink text, and a restrained coral accent aligned with the desktop client.
- A product-oriented hero followed by feature demonstrations and documentation entry points.
- Interface-inspired demonstrations rather than generic illustrations.
- Starlight remains visually recognizable on documentation pages, with brand tokens and component styling applied through supported theme customization.
- Light and dark themes both remain usable, but the landing-page art direction is led by the warm light theme.
- Layouts remain readable from narrow mobile screens through desktop widths.

The site does not import application Tailwind styles or React components. Documentation-specific CSS variables and small Astro components reproduce only the visual concepts needed for explanation.

## Animation Demonstrations

All major demonstrations use the approved **Autoplay Short Loop** behavior:

- Begin only after entering the viewport.
- Run for approximately five to seven seconds.
- Pause briefly on the completed state before looping.
- Include visible pause and replay controls.
- Stop while outside the viewport.
- Render a meaningful completed-state illustration before client-side enhancement.
- Honor `prefers-reduced-motion: reduce` by disabling timeline movement and showing the completed state.
- Keep narration in nearby HTML text so the animation is never the sole source of information.

### 1. AI 发票处理

The sequence presents a realistic WeMail mail-reading view:

1. An invoice attachment is detected in an email.
2. AI identifies the attachment and displays bounded invoice fields such as amount, seller, or invoice number.
3. WeMail checks the platform status.
4. The user authorizes upload when required.
5. The interface transitions to a successful uploaded or associated state.

No real invoice data, credentials, command output, or provider branding appears. The sequence must not imply that upload occurs without user intent or that every attachment format is supported.

### 2. MCP 使用

The sequence demonstrates the security model as well as capability:

1. The user enables Local MCP in settings.
2. WeMail creates a one-time token and a loopback-only connection.
3. A local AI client searches bounded mailbox results.
4. The client prepares a draft or other proposed write action.
5. The animation visibly pauses at the human-confirmation boundary before showing completion.

The animation never renders a usable token and must not suggest that remote MCP services receive unrestricted mailbox access.

### 3. 邮件到行动闭环

The recommended third demonstration shows the broader WeMail AI value:

1. A long email or thread is opened.
2. WeMail generates a concise summary and extracts action items.
3. One action becomes a todo.
4. A contextual reply draft is generated.
5. The user reviews and confirms the result.

This complements the specialized invoice and developer-facing MCP demonstrations. Smart-tag learning can appear as a smaller inline animation on the WeMail AI feature page rather than as a fourth landing-page centerpiece.

## Technical Architecture

`website/` is an independent Node project with its own manifest and lockfile. It is not added to the desktop application's build graph and does not depend on root application packages.

Planned boundaries:

```text
website/
├── package.json
├── package-lock.json
├── astro.config.mjs
├── tsconfig.json
├── Dockerfile
├── server.mjs
├── public/
├── scripts/
│   └── export-raw-markdown.mjs
├── src/
│   ├── components/
│   │   └── demos/
│   ├── content/
│   │   └── docs/
│   ├── pages/
│   │   └── index.astro
│   └── styles/
└── tests/
```

Astro 5 and a compatible Starlight release are locked in `website/package-lock.json`. Starlight owns the documentation content collection, navigation, search index, syntax highlighting, table of contents, and accessible documentation shell. A custom Astro landing page owns the product narrative and feature demonstrations.

Animation components are isolated by feature. A shared controller handles intersection visibility, pause, replay, loop state, and reduced-motion behavior. Feature components own only their scene markup and timeline-specific CSS classes.

## Content and Raw Markdown Flow

Only files authored under `website/src/content/docs/` are public sources. The build never traverses the repository-level `docs/` directory.

The production build runs in this order:

1. Astro and Starlight compile Markdown and MDX into `website/dist/`.
2. `scripts/export-raw-markdown.mjs` walks `website/src/content/docs/`.
3. Each `.md` or `.mdx` file is copied byte-for-byte to the corresponding location under `website/dist/raw/`.
4. The export fails if the destination escapes `dist/raw/`, if two sources resolve to one destination, or if the Astro output directory is missing.

Examples:

```text
src/content/docs/getting-started/install.md
→ dist/raw/getting-started/install.md

src/content/docs/features/mcp.mdx
→ dist/raw/features/mcp.mdx
```

Frontmatter remains present because these files are original sources, not transformed summaries. The runtime serves `.md` and `.mdx` with `text/markdown; charset=utf-8` and `Content-Disposition: inline` so browsers and agents can access them directly.

## Static Runtime Server

`website/server.mjs` uses Node 22 built-in APIs and adds no production dependency. It serves only files under `dist/`.

Required behavior:

- Bind to `0.0.0.0` and use `PORT`, defaulting to `4321`.
- Resolve directory requests to `index.html`.
- Return a plain 404 response for missing files.
- Reject decoded traversal attempts and any resolved path outside `dist/`.
- Set accurate content types for HTML, CSS, JavaScript, JSON, SVG, common raster images, fonts, Markdown, and MDX.
- Apply short revalidation caching to HTML and raw documentation, and long immutable caching to hashed Astro assets.
- Expose `/healthz` with a small successful response.
- Set `X-Content-Type-Options: nosniff` and a conservative referrer policy.
- Shut down cleanly on `SIGTERM` and `SIGINT`.

The server does not provide SPA fallback, runtime Markdown rendering, directory listings, uploads, mutation endpoints, or proxy behavior.

## Docker Image

`website/Dockerfile` uses a two-stage Node 22 Alpine build with `website/` as the Docker build context.

### Build stage

- Copy the independent package manifest and lockfile.
- Run `npm ci`.
- Copy the remaining website sources.
- Run the full production build, including raw Markdown export.

### Runtime stage

- Use a fresh Node 22 Alpine image.
- Set `NODE_ENV=production` and default `PORT=4321`.
- Copy only `dist/` and `server.mjs` from the build stage.
- Run as the built-in non-root `node` user.
- Expose port `4321`.
- Start with `node server.mjs`.

No source Markdown outside `dist/raw/`, development dependency, npm cache, repository secret, desktop binary, or root `.env` file is copied into the runtime image.

## Error Handling and Degraded Behavior

- A malformed content document or invalid Starlight configuration fails the build.
- Raw export errors fail the build instead of silently producing a partial mirror.
- Missing optional illustration assets fall back to styled HTML scene elements.
- Animation controller failure leaves the completed static scene visible.
- Unsupported browsers receive readable documentation without requiring animation playback.
- Runtime requests for missing or unsafe paths return a bounded response without exposing filesystem paths.
- Content must describe feature limitations and confirmation requirements near the relevant instructions, not only on a separate security page.

## Accessibility

- All controls are native buttons with visible focus states and Chinese accessible names.
- Pause and replay are keyboard operable.
- Animated progress is decorative unless its state is also announced in nearby text.
- Color is not the only status signal; icons and labels accompany success, warning, failure, and confirmation states.
- Demonstrations maintain sufficient contrast in supported themes.
- Screen readers encounter concise scene descriptions rather than every decorative layer.
- Reduced-motion users receive no autoplay transforms, progress sweeps, or blinking indicators.

## Testing Strategy

### Content and type checks

- Run Astro/Starlight content validation and TypeScript checks.
- Verify required frontmatter and internal links.

### Raw export tests

- Preserve file contents byte-for-byte.
- Preserve nested relative paths.
- Copy both `.md` and `.mdx`.
- Ignore unrelated file types.
- Reject invalid or colliding destinations.
- Fail when the expected build output directory does not exist.

### Static server tests

- Serve `/`, nested directory indexes, hashed assets, Markdown, and MDX.
- Return correct MIME types and cache policies.
- Serve `/healthz`.
- Return 404 for missing files.
- Reject encoded and decoded path traversal attempts.

### Animation tests

- Verify pause and replay controls.
- Verify intersection-based playback state.
- Verify reduced-motion completed-state behavior.
- Verify the MCP scene includes the confirmation boundary.

### Production verification

- Run the complete production build from `website/`.
- Confirm representative rendered pages and raw sources exist in `dist/`.
- Start `server.mjs` against the built output and perform HTTP smoke requests.
- Build the Docker image from `website/` and request `/healthz`, one rendered page, and one raw Markdown file from the container.

## Acceptance Criteria

- `website/` installs and builds independently with Node 22.
- The production output is entirely static before it enters the runtime image.
- The landing page follows the approved warm product-narrative direction.
- Invoice, MCP, and email-to-action demonstrations use accessible autoplay short loops.
- MCP and write-oriented scenes show a clear human-confirmation boundary.
- Selected Simplified Chinese documentation is available as rendered HTML.
- Every public `.md` and `.mdx` source is directly accessible under `/raw/` with matching relative paths and original contents.
- Repository-level internal `docs/` content is absent from the built site and runtime image.
- The Node 22 server passes health, content-type, 404, cache, and traversal checks.
- The Docker runtime runs as a non-root user and contains only the generated site plus the static server.
