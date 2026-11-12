# Midscene UI tests

AI-driven Playwright suite that uses [`@midscene/web`](https://midscenejs.com/)
to validate the renderer in plain-language assertions instead of
selector chains. The model that powers Midscene is the same OpenAI
endpoint your local Codex CLI is configured against — Codex itself
doesn't expose an HTTP API, so we reuse its underlying account.

## One-time setup

1. **Browser binary**

   ```sh
   npx playwright install chromium
   ```

2. **Model credentials** — copy the example env file and fill in the
   key. The repo's `.gitignore` already excludes `.env*`, so the real
   key never lands in git.

   ```sh
   cp .env.midscene.example .env.midscene
   $EDITOR .env.midscene
   ```

   Required: `MIDSCENE_MODEL_API_KEY` (your OpenAI key — the same one
   Codex uses). `MIDSCENE_MODEL_NAME` defaults to `gpt-4o`; override
   for `gpt-5`, `gpt-4.1`, etc. If you only have `OPENAI_API_KEY` /
   `OPENAI_BASE_URL` exported, the global setup mirrors them onto
   `MIDSCENE_MODEL_*` automatically.

## Run

```sh
npm run test:midscene          # headless
npm run test:midscene:headed   # show the browser
```

The Vite dev server (`npm run dev:renderer`) is started by the
Playwright config if it isn't already running. Each spec spins up its
own mocked Hono API + LLM via `tests/browser/helpers/testServer.ts`,
so no real network calls reach IMAP / SMTP.

## Authoring tips

- Prefer `aiAssert("窗口左侧出现窄图标导航栏")` over selector chains —
  Midscene runs vision against a screenshot.
- Use `aiQuery<T>("…return JSON…")` to extract structured facts.
- Use `ai("点击列表里的第一封邮件")` for high-level interactions.
- Cache LLM responses with `MIDSCENE_CACHE=true` for stable repeat
  runs.
- Reports land under `playwright-report-midscene/` — open
  `index.html` to walk through each step.
