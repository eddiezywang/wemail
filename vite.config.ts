// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Renderer-only dev (`npm run dev:web`) needs a real backend behind
// `/api/*`. The companion `dev:api` script boots `composeApp()` on
// `WEMAIL_DEV_API_PORT` (default 3001); we proxy here so relative
// `/api/account/login` etc. resolve to the Hono server instead of
// hitting Vite (which 405s on POST and serves index.html on GET).
//
// Under `dev:desktop`, the renderer reads `window.wemailDesktop.apiBaseUrl`
// and issues absolute URLs to Electron's own API port — those skip this
// proxy entirely, so the rule is harmless when no backend is on 3001.
const DEV_API_PORT = Number(process.env.WEMAIL_DEV_API_PORT ?? 3001);

export default defineConfig({
  plugins: [
    tailwindcss(),
    reactRouter(),
    // The website is a separate Astro project. Restrict path scanning to the
    // renderer config so a root build does not parse website/tsconfig.json.
    tsconfigPaths({ projects: ["./tsconfig.app.json"] }),
  ],
  optimizeDeps: {
    include: [
      "react",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "react-dom",
      "react-dom/client",
      "react-router",
      "react-router/dom",
      "remark-gfm",
      "@tanstack/react-query",
      "@phosphor-icons/react",
      "sonner",
      "class-variance-authority",
      "clsx",
      "tailwind-merge",
      "zustand",
      "dompurify",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-popover",
      "@radix-ui/react-select",
      "@radix-ui/react-switch",
      "@radix-ui/react-tabs",
      "@radix-ui/react-tooltip",
      "@tiptap/core",
      "@tiptap/react",
      "@tiptap/react/menus",
      "@tiptap/starter-kit",
      "@tiptap/extension-color",
      "@tiptap/extension-highlight",
      "@tiptap/extension-image",
      "@tiptap/extension-link",
      "@tiptap/extension-text-align",
      "@tiptap/extension-text-style",
      "@tiptap/extension-underline",
      "@tiptap/pm/state",
    ],
  },
  server: {
    // Pre-transform the app module graph at server start so the first SSR
    // request completes well inside Vite's 60s module-runner transport
    // timeout (slow cold starts on Windows/Defender-scanned node_modules
    // used to wedge the dev server permanently). Harmless warm-up.
    warmup: {
      clientFiles: [
        "app/root.tsx",
        "app/routes/**/*.tsx",
      ],
      ssrFiles: [
        "app/entry.server.tsx",
        "app/root.tsx",
        "app/routes.ts",
        "app/routes/**/*.tsx",
        "app/components/**/*.{ts,tsx}",
        "app/lib/**/*.ts",
        "app/services/**/*.ts",
        "app/queries/**/*.ts",
        "app/hooks/**/*.ts",
        "app/types/**/*.ts",
        "app/styles/**/*.{ts,tsx,css}",
        "app/copy/**/*.ts",
        "app/index.css",
        "shared/**/*.ts",
      ],
    },
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${DEV_API_PORT}`,
        changeOrigin: false,
      },
    },
  },
});
