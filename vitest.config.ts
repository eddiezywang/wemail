// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const configDirectory = path.dirname(fileURLToPath(import.meta.url));

const commonExclude = [
  "**/node_modules/**",
  "**/dist/**",
  "**/dist-electron/**",
  "tests/e2e/**",
  // These shared contract tests intentionally run under the repository's
  // node:test server suite, not the renderer's Vitest suite.
  "shared/wemail/automationCenter.test.ts",
  "electron/bot-core/channels.test.ts",
];

// These files import `node:test`/`node:assert` and are driven by a node:test
// runner. Vitest only sees a file with no suites, which fails the run with
// "No test suite found". Keep them out of the Vitest `node` project.
const nodeTestFiles = [
  "electron/bot-core/reconnectPacer.test.ts",
  "electron/main/ai-completion-buffer.test.ts",
  "electron/main/ai-job-dispatcher.test.ts",
  "electron/main/bounded-id-set.test.ts",
  "electron/main/business-preferences-cache.test.ts",
  "electron/main/canonical-ai-worker-pool.test.ts",
  "electron/main/canonical-ai-worker.test.ts",
  "electron/main/data-directory.test.ts",
  "electron/main/mail-database-port-broker.test.ts",
];

const domDependentTypeScriptTests = [
  "app/lib/email-document.test.ts",
  "app/lib/external-links.test.ts",
  "app/lib/telemetry.test.ts",
  "app/lib/utils.test.ts",
  "app/services/api.test.ts",
];

/**
 * The server suite stays on `node:test` (see `test:server` in package.json).
 * Vitest uses separate projects so pure TypeScript tests avoid jsdom startup,
 * while renderer tests keep browser globals and per-file isolation.
 */
export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  resolve: {
    alias: {
      "~": path.resolve(configDirectory, "./app"),
      "shared/wemail": path.resolve(configDirectory, "./shared/wemail"),
      shared: path.resolve(configDirectory, "./shared"),
      // P2 module seam: source-level resolution for the open NO_OP stub, so
      // vitest never depends on a compiled dist-electron tree (cold clones).
      // The packaged runtime binds #edition-modules through package.json
      // "imports" instead (see server/wemail/bootstrap/editionModules.ts).
      "#edition-modules": path.resolve(
        configDirectory,
        "./server/wemail/bootstrap/editionModules.noop.ts",
      ),
    },
  },
  test: {
    globals: true,
    css: false,
    // WSL2 workers can time out on bootstrap; forks pool is more reliable.
    pool: "forks",
    maxWorkers: 2,
    fileParallelism: true,
    isolate: true,
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          setupFiles: [],
          include: [
            "app/**/*.test.ts",
            "shared/**/*.test.ts",
            "electron/**/*.test.ts",
          ],
          exclude: [...commonExclude, ...nodeTestFiles, ...domDependentTypeScriptTests],
        },
      },
      {
        extends: true,
        test: {
          name: "renderer",
          environment: "jsdom",
          setupFiles: ["tests/renderer/setup.ts"],
          include: [
            "tests/renderer/**/*.test.tsx",
            "app/**/*.test.tsx",
            ...domDependentTypeScriptTests,
          ],
          exclude: commonExclude,
          deps: {
            optimizer: {
              client: {
                enabled: true,
                include: ["@phosphor-icons/react"],
              },
            },
          },
        },
      },
    ],
  },
});
