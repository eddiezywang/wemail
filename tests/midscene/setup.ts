// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Loads `.env.midscene` (or `.env.midscene.local`) into `process.env`
 * before Playwright tests run, so Midscene's model configuration is
 * available to `PlaywrightAiFixture`. Source values are passed through
 * to either `MIDSCENE_MODEL_*` (preferred) or `OPENAI_*` (fallback).
 *
 * The repository's `.gitignore` already excludes `.env*` files, so the
 * concrete API key never lands in git. `.env.midscene.example` documents
 * the required keys.
 */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..", "..");

function loadEnvFile(file: string) {
	const abs = path.join(PROJECT_ROOT, file);
	if (!fs.existsSync(abs)) return;
	const text = fs.readFileSync(abs, "utf-8");
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		// Strip matching quotes.
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (process.env[key] === undefined) {
			process.env[key] = value;
		}
	}
}

export default async function globalSetup() {
	// Local overrides win over the committed example.
	loadEnvFile(".env.midscene");
	loadEnvFile(".env.midscene.local");

	// Compatibility: if only OPENAI_* are set, mirror them onto
	// MIDSCENE_MODEL_* so the new env scheme works too.
	if (
		!process.env.MIDSCENE_MODEL_API_KEY &&
		process.env.OPENAI_API_KEY
	) {
		process.env.MIDSCENE_MODEL_API_KEY = process.env.OPENAI_API_KEY;
	}
	if (
		!process.env.MIDSCENE_MODEL_BASE_URL &&
		process.env.OPENAI_BASE_URL
	) {
		process.env.MIDSCENE_MODEL_BASE_URL = process.env.OPENAI_BASE_URL;
	}
	if (!process.env.MIDSCENE_MODEL_NAME) {
		process.env.MIDSCENE_MODEL_NAME = "gpt-4o";
	}

	if (!process.env.MIDSCENE_MODEL_API_KEY) {
		throw new Error(
			"[midscene] No MIDSCENE_MODEL_API_KEY / OPENAI_API_KEY found. " +
				"Copy .env.midscene.example to .env.midscene and fill in your key.",
		);
	}

	const baseUrl = process.env.MIDSCENE_MODEL_BASE_URL;
	if (!baseUrl) return;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5_000);
	try {
		// Reachability only: any HTTP response proves the configured model
		// gateway is listening. Actual auth/model compatibility remains the
		// responsibility of Midscene's first call.
		await fetch(baseUrl.replace(/\/$/, ""), {
			headers: { Authorization: `Bearer ${process.env.MIDSCENE_MODEL_API_KEY}` },
			signal: controller.signal,
		});
	} catch (error) {
		let endpoint = baseUrl;
		try {
			const parsed = new URL(baseUrl);
			endpoint = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
		} catch {
			// Keep the configured non-secret endpoint for diagnostics.
		}
		throw new Error(
			`[midscene] Model gateway is unreachable at ${endpoint}. Start the configured multimodal service before running visual acceptance.`,
			{ cause: error },
		);
	} finally {
		clearTimeout(timeout);
	}
}
