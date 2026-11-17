// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * One-shot dev helper: provisions the default mail account in the
 * local SQLite DB so `npm run dev:desktop` boots straight into the
 * workbench. Reads `.env.dev.local` for credentials — that file is
 * gitignored, so the password never leaves the developer's machine.
 *
 * Usage:
 *   1. cp .env.dev.local.example .env.dev.local
 *   2. fill in WEMAIL_DEV_EMAIL / *_PASSWORD / *_HOST / *_PORT
 *   3. npm run dev:seed
 *
 * Stop the desktop app before running — SQLite holds a write lock.
 */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { composeApp } from "../server/wemail/bootstrap/AppComposition.js";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");

function loadEnvFile(file: string) {
	const abs = path.join(PROJECT_ROOT, file);
	if (!fs.existsSync(abs)) return false;
	const text = fs.readFileSync(abs, "utf-8");
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (process.env[key] === undefined) process.env[key] = value;
	}
	return true;
}

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v || !v.trim()) {
		console.error(
			`[seed-dev-account] Missing required env var ${name}. ` +
				"Copy .env.dev.local.example to .env.dev.local and fill it in.",
		);
		process.exit(1);
	}
	return v.trim();
}

async function main() {
	loadEnvFile(".env.dev.local");

	const email = requireEnv("WEMAIL_DEV_EMAIL");
	const displayName =
		process.env.WEMAIL_DEV_DISPLAY_NAME?.trim() || email.split("@")[0]!;
	const imapHost = requireEnv("WEMAIL_DEV_IMAP_HOST");
	const imapPort = Number(requireEnv("WEMAIL_DEV_IMAP_PORT"));
	const imapSecure =
		(process.env.WEMAIL_DEV_IMAP_SECURE ?? "true").toLowerCase() !==
		"false";
	const smtpHost = requireEnv("WEMAIL_DEV_SMTP_HOST");
	const smtpPort = Number(requireEnv("WEMAIL_DEV_SMTP_PORT"));
	const smtpSecure =
		(process.env.WEMAIL_DEV_SMTP_SECURE ?? "true").toLowerCase() !==
		"false";
	const imapPassword = requireEnv("WEMAIL_DEV_IMAP_PASSWORD");
	const smtpPassword =
		process.env.WEMAIL_DEV_SMTP_PASSWORD?.trim() || imapPassword;

	const dataDir =
		process.env.WEMAIL_DATA_DIR ?? path.join(PROJECT_ROOT, ".wemail");
	const logsDir = path.join(dataDir, "logs");
	fs.mkdirSync(dataDir, { recursive: true });
	fs.mkdirSync(logsDir, { recursive: true });

	console.log(
		`[seed-dev-account] dataDir=${dataDir} email=${email} imap=${imapHost}:${imapPort}`,
	);

	const composition = await composeApp({ dataDir, logsDir });
	try {
		const saved = composition.accountService.saveAccount({
			config: {
				id: `acct-${Date.now()}`,
				emailAddress: email,
				displayName,
				imap: {
					host: imapHost,
					port: imapPort,
					secure: imapSecure,
					username: email,
				},
				smtp: {
					host: smtpHost,
					port: smtpPort,
					secure: smtpSecure,
					username: email,
				},
			},
			secrets: { imapPassword, smtpPassword },
		});
		console.log(
			`[seed-dev-account] account saved: id=${saved.id} email=${saved.emailAddress}`,
		);
	} finally {
		await composition.stop();
	}
}

main().catch((err) => {
	console.error("[seed-dev-account] failed:", err);
	process.exit(1);
});
