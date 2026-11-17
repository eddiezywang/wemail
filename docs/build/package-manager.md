# Package manager: Bun (with Node fallback)

WeMail uses **Bun ≥ 1.3** as the canonical package manager and script
runner. The actual runtimes that touch the wire still depend on Node:

| Component | Runtime | Why |
|---|---|---|
| `bun install` / `bun run <script>` | Bun | 2–5× faster install, faster TS exec |
| `node --test` (`test:server`) | Node 20 | `better-sqlite3` is built for Node ABI; native `bun test` would need a Bun-targeted rebuild |
| Vitest renderer suite | Node | jsdom + React Testing Library |
| Electron main / preload | Node (embedded in Electron) | Electron embeds Node; cannot swap |
| Playwright Electron E2E | Node | drives the Electron-embedded Node runtime |

## Day-to-day

```bash
bun install               # generates bun.lock (tracked)
bun run dev:desktop       # vite + electron
bun run test:all          # typecheck + server tests + renderer tests + e2e
bun run package:windows   # docker+wine cross-build
```

`npm install` / `npm run …` still work — Bun and npm both read
`package.json`. We just don't track `package-lock.json` so the two
lockfiles cannot drift.

## Install Bun

```bash
# Linux / WSL2 / macOS
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"
```

Then `bun --version` should report `1.3.x` or higher.

## When to NOT use Bun

- **CI matrix that targets Node-only environments** — keep using `npm ci`
  there; both lockfiles read the same `package.json`.
- **Native `bun test`** — leaves `node:test` API mostly working, but
  fails on every test that opens a SQLite connection. Use
  `bun run test:server` (which spawns `node --test` under the hood).
- **`electron-rebuild` for the Windows cross-build** — runs inside
  the docker container with `npm ci`; that path stays npm to keep the
  Dockerfile portable.
