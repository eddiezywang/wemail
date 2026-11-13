# Two-Repo Edition Split — Tasks

## P0. Repo split baseline (done)

- [x] 0.1 Open baseline repo regenerated without history (single commit),
      secrets/garbage removed, pushed as private `wemail`.
- [x] 0.2 `wemail-int` created with `open/` mirror, `internal/` overlay,
      one-way `sync-open.mjs` (tracked boundary, pinned commit, dirty reject,
      full manifest) and `run-profile-build.mjs` packaging entry.
- [x] 0.3 Codex review of P0 blockers complete (manifest format, tracked-file
      boundary, deletion safety all fixed).

## P1. Edition config seam (implementation complete, closeout in flight)

- [x] 1.1 `shared/wemail/edition.ts`: runtime config type, structural
      validator, filesystem loader with open-default fallback, public
      whitelist view.
- [x] 1.2 `scripts/write-edition-config.ts` build-time generator
      (`WEMAIL_EDITION_OVERLAY`), wired into `build:desktop` +
      `extraResources`.
- [x] 1.3 Composition root consumes edition: extra provider presets,
      onboarding boot override, signature brand URL (server + renderer),
      enterprise directory client factory + auto-init.
- [x] 1.4 `GET /api/system/edition` whitelist endpoint + renderer query;
      onboarding picker-first for open edition (welcome splash removed).
- [x] 1.5 `scripts/check-public-boundary.mjs` ratchet gate + baseline,
      wired into `verify:pr`.
- [x] 1.6 `run-profile-build.mjs` injects overlay env and verifies the
      generated edition artifact post-build.
- [x] 1.7 Full verification: three typechecks, renderer suite, server suite
      touched files, `build:desktop` open default AND overlay form.
      (Renderer suite: 953/959 green; the 6-case gap is a pre-existing
      vitest fork crash in SummaryCenterPage — each case passes
      individually. Dual builds verified under the strict validator with
      edition identity stamps.)
- [x] 1.8 Commit + push both repos; codex review of the P1 stage.
      (Review round 4 verdict: 通过 — all four blockers eliminated with
      evidence; suggestions 2/5/6 confirmed. Follow-ups noted: dedicated
      regression tests for scripts/edition-identity.mjs.)

## P1 review follow-ups (non-blocking, tracked)

- [x] 1.9 Dedicated regression tests for `scripts/edition-identity.mjs`:
      open→internal and internal→open mismatches, missing identity record,
      overlay content change (codex round 4 note). 9 cases in
      `scripts/edition-identity.test.mjs`, wired into `verify:pr` via
      `test:edition-identity`.
- [ ] 1.10 Known pre-existing product defects surfaced by the renderer suite
      repair (not P1 regressions — schedule separately):
      (a) signature brand paragraph parses as editable ProseMirror content
      (empty duplicate node, brand line deletable) — suspected
      ProtectedParagraph vs SignatureBrand rule ordering;
      (b) agent panel width is persisted but never restored on boot
      (`app/components/layout/Workbench.tsx`).

## P2. Internal code extraction → `wemail-int/internal/src`

- [x] 2.1 Extraction inventory document (files, seams, registration entries,
      test impact) for all four modules —
      `wemail-int/internal/docs/p2-extraction-plan.md` (50 files to move,
      ~130 wiring files to split; order below is coupling-ascending).
- [x] 2.2 Edition features seam: `edition.ts` gains a validated `features`
      block (overlay already reserves the four keys) surfaced through the
      PublicEditionInfo whitelist; `useEditionFeatures` hook shares the
      edition query cache. (Hiding internal entry points by feature is
      delivered per-module in 2.3–2.6.)
- [x] 2.3 Office scene detection + internal prompt blocks extraction
      (smallest coupling; adds the `extraPromptSections` seam). Established
      the `#edition-modules` binding + EditionModules injection pattern.
      Codex round 5 flagged 3 blockers in the packaging/DB chain; all
      three (plus the instance-bound contributor suggestion) fixed in
      e21606b — round 6 recheck pending.
- [x] 2.4 Enterprise directory extraction (move Coremail client + pinyin +
      sm-crypto; keep snapshot engine; composition imports the client only
      via the injected factory interface). Directory tests 41/41; open
      boundary gate 148 hits (346 → 214 → 148).
- [ ] 2.5 WeCLI runtime extraction (skills runtime, catalog, routes,
      installer UI; port error classes used by open files).
- [ ] 2.6 Invoice/allowance extraction (largest; keeps queue infrastructure
      + schema v19 + protocol fields in the open tree, injects via
      AllowancePort).
- [ ] 2.7 Per-module: both editions build, boundary baseline shrinks,
      internal features verified via registration entries.

## P3. Machine guards hardening

- [x] 3.1 Open-repo boundary ratchet gate (P1.5).
- [ ] 3.2 Int-repo shared-file parity manifest check (byte-identical vs
      upstream commit, explicit exception allowlist).
- [ ] 3.3 Int-repo internal-config check (no internal endpoints committed
      outside overlay schema; secrets only via env).

## P4. Packaging pipeline (done for current scope)

- [x] 4.1 `run-profile-build.mjs`: preflight → sync → install → build with
      `WEMAIL_EDITION_OVERLAY` → post-build artifact verification
      (`Verified profile=internal` log line required).

## P5. Public sanitization + flip

- [x] 5.1 Boundary baseline driven to zero. Ratchet: 346 -> 214 -> 148
      -> 113 -> 101 -> 87 -> **0 hits / 0 files**; baseline locked to `{}`.
      24 files of fixtures / archival docs neutralized, 301 touched tests
      green, three typechecks green.
- [x] 5.2 README hero image: an earlier turn applied the user-designated
      screenshot as `demo_app.png`. The round-11 review confirmed it carried
      internal context, and the user chose an equivalent sanitized version:
      `demo_app_public.png` (same dimensions, same workbench layout,
      all-neutral copy) now replaces it in both READMEs; the old file is
      removed from the current tree. **Historical copies of the original
      remain in reachable Git history** and must be purged when a clean
      public history is rebuilt — see the round-11 gate list below.
- [x] 5.3 Community files finalized (CONTRIBUTING, SECURITY,
      THIRD_PARTY_NOTICES, CODE_OF_CONDUCT with upstream attribution).
- [x] 5.4 Both editions built + booted locally with separate isolated
      `WEMAIL_DATA_DIR`s. Open edition (no overlay): `profile=open`,
      `/api/system/edition` empty presets / boot=false / features all false,
      WeCLI endpoints 404, full boot chain through `startLocalApi-done`.
      Internal edition (int repo full module overlay via
      `build-with-modules.mjs`, register.js + 4 modules + private deps):
      `/api/system/edition` the internal enterprise preset / boot=true / brand link /
      features all true, wecli catalog 200, directory status 401 (auth),
      health 200. Dev launcher now mirrors the edition file into the
      appPath so packaged-style dev launches resolve it correctly.
- [ ] 5.5 Flip `eddiezywang/wemail` to public — **NOT EXECUTED BY DESIGN**:
      the user explicitly required the repo to remain private
      ("可以生成 github 仓库 但是不要开源"). Flipping visibility requires a
      new explicit instruction.

## Final acceptance

- [x] F.1 Open edition launched locally (`desktop:quick`, isolated data
      dir, no overlay): boot chain integrity-done -> composition-done ->
      startLocalApi-done (port 53807). **Re-verified at final SHA 3e50eb1**
      (port 62570): `/api/system/edition` open defaults, health 200,
      WeCLI endpoint 404; `npm run build:desktop` (no overlay) EXIT=0.
- [x] F.2 Internal edition launched locally (int repo full module overlay,
      separate isolated data dir): boot chain complete (port 63445);
      `/api/system/edition` the internal enterprise preset + bootToCredentials
      + features all true; wecli catalog 200, directory status 401, health 200.
      **Re-verified at final SHA 3e50eb1** (port 59219) with the complete
      formal packaging entry `node internal/scripts/run-profile-build.mjs build`
      EXIT=0 and `Verified profile=internal ... full-field compare vs overlay`
      (C5 contract fix now validated by the real post-build comparison,
      not just an equivalent script).
      Known limitation: `/api/system/wecli/status` resets the connection
      when the wecli CLI is not installed locally (diagnostic endpoint only).
- [x] F.3 `check-public-boundary` reports **0 files / 0 hits** (baseline
      `{}`), parity + internal-config guards green in int repo; CI run
      43272636886 includes the required `public boundary / schema / edition
      identity` job and is fully green.

## Known residuals (tracked, NOT claimed complete)

Reviewed in codex round 10 and kept visible here on purpose. These do not
block the two-repo split or the dual-launch acceptance, but no release note
may describe them as delivered.

- P2.7 / round-9 leftovers: internal renderer invoice counters and display
  wiring; renderer `.tsx` test/type entry point in `wemail-int` (pagination
  uses `emails.length` rather than `totalCount`); Feishu worker's
  "exactly one one-shot fallback delivery" regression; WeCLI/allowance
  real `propose -> HTTP confirmation -> bundle executor` chain (harnesses
  still call `reserveExecution` / dispatch directly).
- Product defects reported by e2e work, not masked by test changes:
  `Workbench.tsx` agent resizer is covered by a same-layer scroll pane;
  `EmailPanelToolbar.tsx` derives `appliedTags` from intelligence artifacts
  instead of tag relations; `scripts/dev-api-server.ts` and
  `scripts/seed-dev-account.ts` still call `composeApp` without a
  `mailDatabase` and therefore fail as standalone dev entry points.
- Test-coverage limits: browser e2e (21 passed locally) is renderer/
  component wiring only — no Mail Core, Canonical AI worker, SMTP or worker
  lifecycle; `06-agent-chat` names claim auto-resume/confirmation recovery
  whose assertions were removed; electron `05` no longer compares the same
  mail identity across re-open; RFC1918 fixtures replaced with loopback
  addresses no longer exercise the private-network update branch.
- Publication-only manual checks (only if the user later asks to make the
  repo public — 5.5 remains unflipped by design): eyeball the user-chosen
  hero screenshot's sample mail text; produce a real per-dependency license
  inventory instead of the generic THIRD_PARTY_NOTICES sentence; verify
  the private Security Advisory channel; confirm the final SHA's
  ubuntu-24.04 browser + electron e2e and verification-gate results.

## Round-11 open-readiness remediation (2026-11-13)

Independent codex review conclusion: **do not publish yet** — the current
tree's zero-hit gate, parity and CI are real, but gate/CI coverage does not
reach reachable Git history, identity metadata, audit logs, image content
or distribution license assets. Full report: E:/temp/codex-open-readiness-review.md
(external to the repos).

Delivered in this round (user-approved scope: code items + sanitized hero,
NO history rewrite / identity change / visibility flip):

- Removed four tracked runtime `audit.log` files (gate did not scan `.log`).
- `check-public-boundary.mjs` now enumerates every tracked file, skips
  binaries by NUL-byte detection, recognizes `.env*`, and keeps all deny
  rules plus the baseline `{}`; 7 synthetic regression cases added.
- Fixed the internal packaging contract drift: the stale `preferred`
  preset field was dropped from overlay/schema/post-build expectation,
  matching the shared validator (full-field post-build compare now holds).
- CI gained an unconditional `public-boundary` job running boundary +
  canonical schema + edition-identity checks; `verification-gate` requires
  its success, including docs/website-only PRs.
- Website download CTA hidden, 0-byte installer placeholder removed,
  `.dockerignore` stale rule cleaned; website tests/astro check green.
- README install instructions aligned to `bun install --frozen-lockfile`.
- README hero replaced with the equivalent sanitized illustration; old
  image removed from the current tree.

Still required before any visibility change (owner decisions / separate work):

1. Rebuild a clean public root history from an audited snapshot (reachable
   commits still contain extracted internal modules, a telemetry endpoint
   and the original hero image); coordinate the int-repo manifest pin and
   re-run every verification on the new SHA.
2. Use approved author/committer identities (current Git metadata exposes
   an enterprise domain) and confirm the old model-service key revocation.
3. Complete font/dependency license materials (four WOFF2 assets ship
   without authorization text; sharp native LGPL obligations; a real
   per-lockfile license inventory), and verify the private Security
   Advisory channel.
4. Remaining known items: API Host/Origin hardening and image-proxy DNS
   rebinding, leftover internal tool logic in the open tree, log-message
   redaction promises, int-repo unlocked `npm install`, and the standalone
   dev entry points. Visibility stays PRIVATE until the user explicitly
   authorizes a flip.

## Round-12 clean public history (2026-11-13)

User authorized all round-11 publication gates **but explicitly kept the
repository PRIVATE**. This round therefore prepares the tree for a future
publication without changing visibility.

- Replaced the reachable multi-commit history with a single clean root
  commit built from the audited snapshot: same tracked tree, approved
  noreply author/committer identity, no internal implementation/config
  in any reachable commit. A local backup branch retains the pre-rewrite
  objects; the extra remote topic branch that still pointed at old
  commits was removed.
- Removed the remaining distribution-license gap for the bundled font
  (OFL text alongside the WOFF2 assets) and added an offline,
  reproducible per-dependency license inventory plus explicit notices
  for the special-license native/MPL/dual-license packages.
- SECURITY.md now states accurately which private reporting / scanning
  features are unavailable while the repository is private; enabling and
  verifying them is an owner action required before any future flip.
- Items that cannot be performed by an agent and remain owner actions:
  ~~confirm revocation of the historical model-service key with the
  provider~~ **confirmed revoked by the owner (2026-11-13)**; verify the
  private advisory channel from a non-maintainer
  perspective; re-check the final artifact on the exact release SHA;
  decide whether to ask GitHub to purge any cached old objects.
- Visibility was NOT changed. No public flip is authorized by this round.
