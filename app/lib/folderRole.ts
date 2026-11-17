// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export type FolderRole =
	| "inbox"
	| "sent"
	| "drafts"
	| "trash"
	| "archive"
	| "custom";

const NORMALIZED: Record<string, FolderRole> = {
	inbox: "inbox",
	"[gmail]/inbox": "inbox",
	"受信トレイ": "inbox",
	"收件箱": "inbox",
	"收件夹": "inbox",
	"входящие": "inbox",

	sent: "sent",
	"sent items": "sent",
	"sent mail": "sent",
	"sent messages": "sent",
	"[gmail]/sent mail": "sent",
	"已发送": "sent",
	"已寄出": "sent",
	"送信済み": "sent",
	"送信済みメール": "sent",
	"отправленные": "sent",

	drafts: "drafts",
	draft: "drafts",
	"[gmail]/drafts": "drafts",
	"草稿": "drafts",
	"下書き": "drafts",
	"черновики": "drafts",

	trash: "trash",
	bin: "trash",
	"deleted items": "trash",
	"deleted messages": "trash",
	"[gmail]/trash": "trash",
	"[gmail]/bin": "trash",
	"已删除": "trash",
	"已刪除": "trash",
	"ゴミ箱": "trash",
	"корзина": "trash",

	archive: "archive",
	archived: "archive",
	"all mail": "archive",
	"[gmail]/all mail": "archive",
	"归档": "archive",
	"封存": "archive",
	"アーカイブ": "archive",
	"архив": "archive",
};

export function folderRole(name: string): FolderRole {
	const key = name.trim().toLowerCase();
	return NORMALIZED[key] ?? "custom";
}
