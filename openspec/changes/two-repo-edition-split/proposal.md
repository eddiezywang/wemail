## Why

WeMail is being prepared for open source, but the current single-tree codebase
interleaves a shippable generic AI-native email framework with enterprise
internal logic (invoice/allowance flows, WeCLI runtime, enterprise directory
defaults, internal hostnames and network addresses). Publishing the tree as-is
would leak internal identifiers; deleting the internal logic would break the
internal build. A two-repo scheme (mirroring the proven WeWorker /
WeWorker-Int precedent) lets the open repo carry a complete, self-contained
framework while a private overlay repo carries only what must never be public.

## What Changes

- **Two repos, one product.** `wemail` (this repo, open baseline) stays
  buildable and usable with zero private inputs. `wemail-int` (private)
  vendors this repo under `open/` via a one-way tracked-file sync and layers
  `internal/` (overlay config, private modules, packaging pipeline).
- **Edition seam (P1).** All open-versus-internal divergence that is
  configuration-shaped flows through one validated contract:
  `shared/wemail/edition.ts`. A build-time generator reads
  `WEMAIL_EDITION_OVERLAY` and emits `build/edition/edition-runtime.json`;
  the desktop main process loads it at startup; the composition root
  assembles provider presets, onboarding boot behavior, signature brand URL,
  and enterprise directory injection from it. The renderer only ever sees a
  whitelisted view via `GET /api/system/edition`.
- **Internal code extraction (P2).** Invoice/allowance, WeCLI, enterprise
  directory, and office scene detection move out of the open tree into
  `wemail-int/internal/src`, re-entering through thin registration entries
  at existing composition seams. The open tree keeps generic mechanisms with
  no internal defaults.
- **Machine guards (P3).** A ratchet boundary gate in the open repo fails on
  any new internal identifier; the internal repo gains a shared-file parity
  manifest check so drift between `open/` and upstream is detected.
- **Public sanitization (P5).** Residual internal identifiers in docs,
  fixtures, and comments are driven to zero (ratchet baseline shrinks to
  empty), community files are finalized, and only then does the open repo
  flip to public.

## Impact

- Affected capabilities: `edition-config` (new), `public-boundary` (new),
  `internal-overlay` (new), `repo-hygiene` (new).
- Primary paths: `shared/wemail/edition.ts`, `scripts/write-edition-config.ts`,
  `server/wemail/bootstrap/AppComposition.ts`,
  `server/api/routes/systemRoutes.ts`, `app/routes/onboarding.tsx`,
  `scripts/check-public-boundary.mjs`, and the `wemail-int` mirror of this
  tree.
- The internal build never patches open files: divergence happens only via
  overlay JSON, registration entries, and env contracts. Sync is one-way
  (open → int), pinned to a commit, and refuses dirty sources.
- No renderer feature is removed from the internal build; the open build
  must remain independently usable (picker-first onboarding, generic mail +
  AI features intact).
