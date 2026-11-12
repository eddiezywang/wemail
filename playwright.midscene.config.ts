// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { defineConfig } from "@playwright/test";

/**
 * Playwright config for AI-driven UI tests powered by `@midscene/web`.
 *
 * `tests/midscene/setup.ts` loads model credentials from
 * `.env.midscene` so the Midscene fixture finds the OpenAI-compatible
 * endpoint Codex uses. Run with `npm run test:midscene`.
 */
export default defineConfig({
	testDir: "./tests/midscene",
	testMatch: /.*\.spec\.ts$/,
	timeout: 180_000,
	expect: { timeout: 30_000 },
	fullyParallel: false,
	retries: 0,
	workers: 1,
	reporter: [
		["list"],
		["html", { outputFolder: "playwright-report-midscene", open: "never" }],
	],
	use: {
		baseURL: "http://127.0.0.1:14174",
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		video: "off",
		viewport: { width: 1366, height: 800 },
	},
	globalSetup: "./tests/midscene/setup.ts",
	webServer: {
		command: "node scripts/serve-built-renderer.mjs --root . --port 14174",
		port: 14174,
		reuseExistingServer: false,
		timeout: 60_000,
	},
});
