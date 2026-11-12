# WeMail E2E Tests

Playwright-driven Electron end-to-end specs.

## Run

```bash
npm run test:e2e           # headless
npm run test:e2e:headed    # attached window (needs WSLg or X11)
```

## Requirements

- **Electron binary installed** — `node_modules/electron/dist/electron` must exist.
  `npm install` normally fetches it via postinstall; if the download fails (common
  in offline / locked-down networks), rerun:
  ```bash
  node node_modules/electron/install.js
  ```
  Or set `ELECTRON_MIRROR` / `ELECTRON_CUSTOM_DIR` env vars to point at an
  internal mirror before `npm ci`.
- **Display** — WSLg (Windows 11) provides `DISPLAY=:0` automatically. On
  plain WSL2 / CI, prefix the command with `xvfb-run`:
  ```bash
  xvfb-run -a npm run test:e2e
  ```

## Specs

| File | What it covers |
|------|----------------|
| `01-login-flow.spec.ts` | Unlogged → save account → API reports it |
| `02-sync-detail-summary.spec.ts` | Sync mock inbox → list → detail → summary |
| `03-tag-reject.spec.ts` | Reject a tag → feedback rule persisted |
| `04-reply-draft-edit-send.spec.ts` | Edit & Send draft → feedback + compose |
| `05-logout-preserves-db.spec.ts` | Logout → re-launch same data dir → mail preserved |

## Fake infrastructure

- **IMAP/SMTP**: `FileInjectedMailProvider` reads `<dataDir>/mock-inbox/*.json`
  and writes outbox to `<dataDir>/mock-outbox/`. Activated when
  `WEMAIL_E2E_MODE=1` is set (electron/main/local-api.ts honors this).
- **LLM**: each test spawns a local HTTP mock returning canned JSON. The URL
  is passed to the app via `WEMAIL_E2E_LLM_URL`.

No real IMAP/SMTP/LLM traffic is ever produced.
