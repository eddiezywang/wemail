# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WeMail is an Electron desktop email client with local-first storage. It syncs mail via IMAP/SMTP, runs AI-powered intelligence (summaries, smart tags, reply drafts) locally through an LLM, and includes a PI-based agent runtime with WeCLI skill integration. Originally built on Cloudflare Workers, it has been forked into a standalone Windows desktop app with no cloud dependencies.

## Commands

### Development
```bash
npm run dev:renderer          # Vite dev server on :5173
npm run dev:desktop           # Concurrent renderer + Electron main process
```

### Build
```bash
npm run build                 # React Router build (Vite SSR)
npm run build:desktop         # tsc compile Electron main/preload
npm run package:desktop       # build:desktop + electron-builder --win
npm run package:windows       # Docker-based cross-build (bash scripts/build-windows.sh)
npm run ship                  # Full pipeline: typecheck + test all + package windows
```

### Test
```bash
npm run test:server           # Walks server/**/*.test.ts, runs via node --import tsx --test
npm run test:renderer         # vitest run (jsdom, tests/renderer/ + app/**/*.test.{tsx,ts} + shared/**/*.test.ts)
npm run test:renderer:watch   # vitest in watch mode
npm run test:e2e              # Rebuilds better-sqlite3 for Electron, runs Playwright
npm run test:e2e:headed       # Playwright with visible browser
npm run test:browser          # Playwright + Chromium + standalone Hono API (no Electron)
npm run test:browser:headed   # Browser E2E with visible browser
npm run test:browser:ui       # Browser E2E with Playwright UI
npm run test:all              # typecheck:server + typecheck:desktop + test:server + test:renderer + test:browser
```

### Typecheck
```bash
npm run typecheck:server      # tsc -p server/tsconfig.json --noEmit
npm run typecheck:desktop     # tsc -p electron/tsconfig.json --noEmit
npm run typecheck             # react-router typegen && tsc -b
```

There is no linter or formatter configured. TypeScript strict mode is the primary static analysis.

## Architecture

Three-layer Electron app: **Electron shell** → **Hono local API** → **React renderer**.

### Layer 1: Electron Main Process (`electron/`)
- `main/app.ts` — Entry point: creates BrowserWindow, starts local API, tray, updater
- `main/local-api.ts` — Bridges Electron to server; creates `composeApp()`, starts Hono on port 0
- `preload/index.ts` — Context bridge exposing `wemailDesktop` API (platform, apiBaseUrl, IPC)

### Layer 2: Local API Server (`server/`)
- `api/app.ts` — Hono HTTP app mounting routes: /api/account, mail, intelligence, agent, skills, settings, system
- `wemail/bootstrap/AppComposition.ts` — **Composition root** (~610 lines, hand-written DI). Wires all services in order. Per-account services (MailProvider, MailSync, IntelligenceOrchestrator, QueueRunner) are lazily created on login and torn down on logout with a generation counter to prevent race conditions.

Key subsystems:
- **Mail**: `MailProvider` interface → `ImapSmtpMailProvider` (imapflow + nodemailer). `MailSyncService` does cursor-based incremental sync. `MailRepository` persists to SQLite.
- **Intelligence Pipeline**: `MailSyncService` → `IntelligenceOrchestrator` (pre-screens, plans fan-out via strategy, enqueues jobs per capability) → `QueueRunner` (polling with lease, retry budget, expired-lease recovery) → Processors (`SummaryProcessor`, `TagProcessor`, `ReplyDecisionProcessor`, `ReplyDraftProcessor`).
- **LLM**: `LlmClient` interface with `OpenAiCompatibleClient` and `AnthropicMessagesClient` adapters. Error classification: retryable vs non-retryable.
- **Agent**: `PiAgentRuntime` with max 6 tool iterations, 30s per tool, 120s per run. `MailAgentTools` provides 7 tools. Safety: no send_mail tool; WeCLI mutations are preview-only.
- **WeCLI**: `WecliCommandClassifier` (ls/list = auto-execute, else requires confirmation). `WecliSkillRuntime` with audit logging.
- **Security**: `DataRetentionService` (30-day purge of body/attachment cache and logs). `SecretStore` (file-backed, safeStorage encryption). Tag feedback and draft feedback Markdown are never purged.

### Layer 3: React Renderer (`app/`)
- React Router 7 (SSR + hydration) with TanStack React Query 5 + Zustand 5
- `services/api.ts` — Dual-mode API client: detects desktop via `window.wemailDesktop.apiBaseUrl`, falls back to cloud mode
- `components/wemail/` — Intelligence UI: EmailSummaryCard, EmailSmartTags, SmartDraftPanel, IntelligenceStatus, QueueStatusBadge, AgentActionConfirmDialog
- Rich text: TipTap 3.20 for compose
- Styling: Tailwind CSS 4 + Cloudflare Kumo component library

### Shared Types (`shared/`)
Cross-process TypeScript contracts: `account.ts`, `agent.ts`, `intelligence.ts`, `mail.ts`, `queue.ts`, `skills.ts`, `dates.ts`, `folders.ts`. No server or renderer imports allowed from shared.

### Database (`server/wemail/database/`)
The canonical schema is generated in `Schema.generated.ts` and created directly at schema version 6. Desktop mail reads/writes use the Electron DB Service lanes; incompatible local databases require the explicit demo reset and are never migrated or selected through a fallback path.

### E2E Testing (`tests/`)
- **Browser E2E** (`tests/browser/`): Playwright drives Chromium + standalone Hono API. No Electron needed. `testServer.ts` starts `composeApp()` with `FileInjectedMailProvider` and mock LLM. `mockDesktop.ts` injects `window.wemailDesktop.apiBaseUrl`. Config: `playwright.browser.config.ts`.
- **Electron E2E** (`tests/e2e/`): Playwright with Electron driver, single worker, 60s timeout. `FileInjectedMailProvider` reads `<dataDir>/mock-inbox/*.json` when `WEMAIL_E2E_MODE=1`. LLM traffic routed to local mock via `WEMAIL_LLM_BASE_URL`.
- **Renderer tests**: Vitest + jsdom for component unit tests. Covers `app/**/*.test.{tsx,ts}` and `shared/**/*.test.ts`.

## Critical Invariants

- **No auto-send**: Drafts and agent actions never automatically send email
- **No mail body in logs**: AppLogger rejects forbidden keys; no body in traces or audit logs
- **Logout preserves data**: Logout deletes secrets but keeps cached mail, intelligence results, tag feedback, and audit logs
- **Tag feedback loop**: Reject rules suppress future matching tags; accept removes the rule
- **WeCLI safety**: Mutations require confirmation token; ls/list auto-execute only
- **Agent hard caps**: Max 6 tool iterations, 30s per tool call, 120s per run

## Pending Work

Package M (E2E Playwright & Vitest Renderer Suite) has been restructured as browser-based E2E tests. The new approach uses Playwright + Chromium + standalone Hono API (no Electron driver). See `openspec/specs/e2e-playwright/test-plan.md` for the full design.

Current status:
- Browser E2E infrastructure: `tests/browser/helpers/` (testServer, mockDesktop, testFixture) + `playwright.browser.config.ts` — complete
- Browser E2E specs: 6 spec files (login, sync-summary, tag-reject, reply-draft, settings, agent-chat) — written, need runtime validation
- Renderer component tests: 11 total (4 original + 7 new: IntelligenceStatus, QueueStatusBadge, useUIStore, EmailPanelHeader, EmailAttachmentList, search-parser, dates) — written, need runtime validation
- npm scripts: `test:browser`, `test:browser:headed`, `test:browser:ui` — wired

All other packages (A–L, N) are complete.
