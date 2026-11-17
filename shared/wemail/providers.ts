// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * IMAP/SMTP defaults for the providers shown in the onboarding
 * picker. Both renderer (provider step) and server (validation /
 * suggestions) can import this table.
 */

export interface ProviderPreset {
	id: string;
	label: string;
	domains: string[];
	imap: { host: string; port: number; secure: boolean };
	smtp: { host: string; port: number; secure: boolean };
	helpUrl?: string;
	helpHint?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
	{
		id: "netease-163",
		label: "163 邮箱",
		domains: ["163.com"],
		imap: { host: "imap.163.com", port: 993, secure: true },
		smtp: { host: "smtp.163.com", port: 465, secure: true },
		helpUrl: "https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac25ef2e192b234ae4d",
		helpHint: "需要在 163 邮箱设置里开启 IMAP/SMTP 并使用 16 位授权码",
	},
	{
		id: "netease-126",
		label: "126 邮箱",
		domains: ["126.com"],
		imap: { host: "imap.126.com", port: 993, secure: true },
		smtp: { host: "smtp.126.com", port: 465, secure: true },
	},
	{
		id: "qq",
		label: "QQ 邮箱",
		domains: ["qq.com", "foxmail.com"],
		imap: { host: "imap.qq.com", port: 993, secure: true },
		smtp: { host: "smtp.qq.com", port: 465, secure: true },
		helpUrl: "https://service.mail.qq.com/detail/0/75",
		helpHint: "需在 QQ 邮箱设置中开启 IMAP/SMTP 并生成授权码",
	},
	{
		id: "gmail",
		label: "Gmail",
		domains: ["gmail.com", "googlemail.com"],
		imap: { host: "imap.gmail.com", port: 993, secure: true },
		smtp: { host: "smtp.gmail.com", port: 465, secure: true },
		helpUrl: "https://support.google.com/mail/answer/7126229",
		helpHint: "Use an App Password if 2-factor auth is enabled",
	},
	{
		id: "outlook",
		label: "Outlook / Hotmail",
		domains: ["outlook.com", "hotmail.com", "live.com"],
		imap: { host: "outlook.office365.com", port: 993, secure: true },
		smtp: { host: "smtp.office365.com", port: 587, secure: false },
	},
	{
		id: "icloud",
		label: "iCloud",
		domains: ["icloud.com", "me.com", "mac.com"],
		imap: { host: "imap.mail.me.com", port: 993, secure: true },
		smtp: { host: "smtp.mail.me.com", port: 587, secure: false },
		helpHint: "Generate an app-specific password in your Apple ID settings",
	},
	{
		id: "imap",
		label: "IMAP / SMTP 自定义",
		domains: [],
		imap: { host: "", port: 993, secure: true },
		smtp: { host: "", port: 465, secure: true },
	},
];

export function findPresetByEmail(email: string): ProviderPreset | undefined {
	const at = email.indexOf("@");
	if (at < 0) return undefined;
	const domain = email.slice(at + 1).toLowerCase();
	return PROVIDER_PRESETS.find((p) => p.domains.includes(domain));
}
