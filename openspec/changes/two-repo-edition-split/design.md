# Two-Repo Edition Split — Design

## 1. Repo model

```
eddiezywang/wemail        (open baseline; this repo; PRIVATE until P5)
    │  one-way sync: git ls-files boundary, pinned commit, dirty-source reject
    ▼
eddiezywang/wemail-int    (private overlay repo)
    ├── open/                 vendored copy of the open baseline (synced)
    ├── internal/
    │   ├── config/           build-overlay.json (+ schema, env.example)
    │   ├── src/              private modules extracted in P2
    │   └── scripts/          run-profile-build.mjs (the only packaging entry)
    └── scripts/              sync-open.mjs, prune-open.mjs
```

Discipline (inherited from WeWorker/WeWorker-Int):

- The int repo **never patches** files under `open/`. All divergence is data
  (overlay JSON), thin registration entries consumed by open-tree seams, or
  env contracts.
- Sync is one-way and reproducible: `sync-open.mjs` records the source commit
  and full file manifest; stale files are deleted with path-safety checks.
- Secrets live only in build-time env vars (`internal/config/env.example`
  documents the contract); nothing secret is committed to either repo.

## 2. Edition seam (P1) — data flow

```
wemail-int internal/config/build-overlay.json          (private)
        │  WEMAIL_EDITION_OVERLAY=<path>
        ▼
scripts/write-edition-config.ts                        (open tree, build time)
        │  validateEditionRuntimeConfig → build/edition/edition-runtime.json
        ▼
electron/main/app.ts  loadEditionRuntimeConfig()       (startup, resources → app → cwd)
        ▼
composeApp({ edition })                                 (composition root)
        ├── providerPresets   → /api/system/edition → onboarding picker
        ├── onboarding.bootToCredentials → auto-advance to preferred preset
        ├── signature.brandUrl → MailActionExecutor + compose form footer
        └── enterpriseDirectory → CoremailWebClient factory + auto-init
```

Validation is structural and shared by the generator and the composition root
(duplicate preset ids, port ranges, safe http(s) URLs, `@domain`). A malformed
or missing file at runtime falls back to `OPEN_EDITION_DEFAULT` — edition
problems must never brick startup. The renderer sees only the
`PublicEditionInfo` whitelist (no profile, no directory config).

Open default = picker-first onboarding, no extra presets, plain-text
signature brand, no directory. Internal overlay = the private provider preset,
boot straight
to its credentials, brand link, directory auto-init on the internal domain.

## 3. Internal module extraction (P2)

Modules move to `wemail-int/internal/src` and re-enter through existing
seams — `ComposeAppOverrides`, the `bootstrap/composition/*` assembly files,
feature flags, and factory interfaces (`CoremailWebClient` already accepts an
injected `baseUrl`; `AutomationProviderRegistry`, `AgentTool` factories, and
the renderer `AgentToolRendererRegistry` provide the rest).

Extraction order (coupling-first): invoice/allowance → WeCLI → enterprise
directory → office scene detection. Each step: move files, add registration
entry in int repo, strip internal defaults from open tree, shrink the
boundary baseline, keep both editions green.

## 4. Machine guards (P3)

- `scripts/check-public-boundary.mjs` (open repo, wired into `verify:pr`):
  deny patterns (org name, internal hosts/registry/brand, banned upstream
  name, internal/private IPs) over git-tracked text files, compared against
  `scripts/public-boundary-baseline.json`. Ratchet semantics: counts may only
  shrink; growth or new files fail the gate. Regeneration requires an explicit
  `--update-baseline` and a justified diff.
- Parity manifest (int repo): shared-file list must match upstream byte-for-
  byte; exceptions require an explicit allowlist entry.

## 5. Public flip (P5)

- Drive the boundary baseline to zero (docs, fixtures, comments; P2 already
  removed the module code).
- Replace the README hero image (current one contains internal system names).
- Finalize community files (CONTRIBUTING, SECURITY, THIRD_PARTY_NOTICES
  attributing the Cloudflare Agentic Inbox upstream under Apache-2.0).
- Flip GitHub visibility to public only after the gate reports zero and both
  editions build and boot.

## 6. Verification per stage

Every stage closes with: three typechecks green, targeted tests green,
`build:desktop` succeeds in BOTH forms (open default; overlay via
`WEMAIL_EDITION_OVERLAY`), boundary ratchet not grown, and — for behavior-
changing stages — a local boot of both editions with isolated data dirs
(`WEMAIL_DATA_DIR`), verified via startup logs (`composition-done`) and the
onboarding entry each edition must show.
