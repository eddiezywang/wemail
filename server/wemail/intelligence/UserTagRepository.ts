import { createHash, randomUUID } from "node:crypto";
import type { MailDatabase } from "../database/Database.js";
import type { UserTag } from "../../../shared/wemail/userTags.js";
export type { UserTag } from "../../../shared/wemail/userTags.js";

/**
 * UserTagRepository — persistence for user-defined smart tags.
 *
 * The user creates a tag with a name and a free-form prompt that
 * describes when the tag should apply. The TagProcessor reads these
 * rows when running over an account's mail and includes them in the
 * candidate-tag set sent to the LLM (alongside the built-in vocabulary).
 * Colors are not stored — `tagDotColor` in the renderer hashes the name
 * so identical tags read the same across the app.
 *
 * Names are unique per account (UNIQUE constraint in the schema).
 */
interface Row {
	id: string;
	account_id: string;
	name: string;
	description?: string;
	prompt: string;
	optimized_prompt: string | null;
	optimized_prompt_version: string | null;
	optimized_from_prompt_hash: string | null;
	optimized_at: string | null;
	creation_source: string;
	source_topic_id: string | null;
	created_at: string;
	updated_at: string;
}

const TAG_SELECT = `SELECT tags.public_id AS id, accounts.public_id AS account_id,
  tags.name, tags.description, tags.prompt, tags.optimized_prompt,
  tags.optimized_prompt_version, tags.optimized_from_prompt_hash,
  CASE WHEN tags.optimized_at_ms IS NULL THEN NULL ELSE datetime(tags.optimized_at_ms / 1000, 'unixepoch') END AS optimized_at,
  tags.creation_source, tags.source_topic_public_id AS source_topic_id,
  datetime(tags.created_at_ms / 1000, 'unixepoch') AS created_at,
  datetime(tags.updated_at_ms / 1000, 'unixepoch') AS updated_at
  FROM mail_user_tags tags JOIN mail_accounts accounts ON accounts.id = tags.account_id`;

function rowToTag(row: Row): UserTag {
	return {
		id: row.id,
		accountId: row.account_id,
		name: row.name,
		description: row.description ?? "",
		prompt: row.prompt,
		optimizedPrompt: row.optimized_prompt ?? undefined,
		optimizedPromptVersion: row.optimized_prompt_version ?? undefined,
		optimizedFromPromptHash: row.optimized_from_prompt_hash ?? undefined,
		optimizedAt: row.optimized_at ?? undefined,
		effectivePrompt: row.optimized_prompt?.trim() || row.prompt,
		creationSource: row.creation_source === "topic_suggestion" ? "topic-suggestion" : "manual",
		sourceTopicId: row.source_topic_id ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class UserTagRepository {
	constructor(
		private readonly db: MailDatabase,
		private readonly now: () => string = () => new Date().toISOString(),
	) {}

	/**
	 * Create a user tag. Idempotent on (accountId, name) — re-creating an
	 * existing tag updates its prompt instead of erroring.
	 */
	upsert(input: {
		accountId: string;
		name: string;
		description?: string;
		prompt?: string;
		creationSource?: "manual" | "topic-suggestion";
		sourceTopicId?: string;
	}): UserTag {
		const id = `utag-${randomUUID()}`;
		const now = this.now();
		const nowMs = parseTime(now);
		const name = input.name.trim();
		const description = input.description?.trim() ?? "";
		const prompt = (input.prompt?.trim() || defaultSmartTagPrompt(name, description)).trim();
		this.db
			.prepare(
				`INSERT INTO mail_user_tags (
				   public_id, account_id, name, name_norm, description, prompt,
				   optimized_prompt, optimized_prompt_version,
				   optimized_from_prompt_hash, optimized_at_ms,
				   creation_source, source_topic_public_id, created_at_ms, updated_at_ms
				 ) SELECT
				   @id, accounts.id, @name, @nameNorm, @description, @prompt,
				   NULL, NULL, NULL, NULL, @creationSource, @sourceTopicId, @nowMs, @nowMs
				 FROM mail_accounts accounts WHERE accounts.public_id = @accountId
				 ON CONFLICT(account_id, name_norm) DO UPDATE SET
				   name = excluded.name,
				   description = excluded.description,
				   prompt = excluded.prompt,
				   optimized_prompt = NULL,
				   optimized_prompt_version = NULL,
				   optimized_from_prompt_hash = NULL,
				   optimized_at_ms = NULL,
				   updated_at_ms = excluded.updated_at_ms`,
			)
			.run({
				id,
				accountId: input.accountId,
				name,
				nameNorm: normalizeTagName(name),
				description,
				prompt,
				creationSource: input.creationSource === "topic-suggestion" ? "topic_suggestion" : "manual",
				sourceTopicId: input.sourceTopicId ?? null,
				nowMs,
			});
		const row = this.db
			.prepare(
				`${TAG_SELECT} WHERE accounts.public_id = @accountId AND tags.name_norm = @nameNorm`,
			)
			.get({ accountId: input.accountId, nameNorm: normalizeTagName(name) }) as
			| Row
			| undefined;
		if (!row) {
			throw new Error("user-tag-upsert-missing");
		}
		return rowToTag(row);
	}

	updateById(input: {
		id: string;
		name?: string;
		description?: string;
		prompt?: string;
	}): UserTag | null {
		const existing = this.getById(input.id);
		if (!existing) return null;
		const name = input.name?.trim() || existing.name;
		const description =
			input.description === undefined ? existing.description : input.description.trim();
		const prompt =
			input.prompt === undefined
				? existing.prompt
				: (input.prompt.trim() || defaultSmartTagPrompt(name, description));
		const now = this.now();
		const nowMs = parseTime(now);
		this.db
			.prepare(
				`UPDATE mail_user_tags
				    SET name = @name,
				        name_norm = @nameNorm,
				        description = @description,
				        prompt = @prompt,
				        optimized_prompt = NULL,
				        optimized_prompt_version = NULL,
				        optimized_from_prompt_hash = NULL,
				        optimized_at_ms = NULL,
				        updated_at_ms = @nowMs
				  WHERE public_id = @id`,
			)
			.run({ id: input.id, name, nameNorm: normalizeTagName(name), description, prompt, nowMs });
		return this.getById(input.id);
	}

	updatePrompt(id: string, prompt: string): UserTag | null {
		const now = this.now();
		const nowMs = parseTime(now);
		this.db
			.prepare(
				`UPDATE mail_user_tags
				    SET prompt = @prompt,
				        optimized_prompt = NULL,
				        optimized_prompt_version = NULL,
				        optimized_from_prompt_hash = NULL,
				        optimized_at_ms = NULL,
				        updated_at_ms = @nowMs
				  WHERE public_id = @id`,
			)
			.run({ id, prompt: prompt.trim(), nowMs });
		return this.getById(id);
	}

	activateOptimizedPrompt(input: {
		id: string;
		prompt: string;
		version: string;
		expectedSourcePromptHash: string;
		expectedActivePromptHash: string;
	}): UserTag | null {
		const existing = this.getById(input.id);
		if (!existing) return null;
		if (smartTagPromptHash(existing.prompt) !== input.expectedSourcePromptHash) {
			return null;
		}
		if (smartTagPromptHash(existing.effectivePrompt) !== input.expectedActivePromptHash) {
			return null;
		}
		const now = this.now();
		const nowMs = parseTime(now);
		this.db
			.prepare(
				`UPDATE mail_user_tags
				    SET optimized_prompt = @prompt,
				        optimized_prompt_version = @version,
				        optimized_from_prompt_hash = @sourcePromptHash,
				        optimized_at_ms = @nowMs,
				        updated_at_ms = @nowMs
				  WHERE public_id = @id`,
			)
			.run({
				id: input.id,
				prompt: input.prompt.trim(),
				version: input.version,
				sourcePromptHash: input.expectedSourcePromptHash,
				nowMs,
			});
		return this.getById(input.id);
	}

	restoreOriginalPrompt(id: string): UserTag | null {
		const now = this.now();
		const nowMs = parseTime(now);
		this.db
			.prepare(
				`UPDATE mail_user_tags
				    SET optimized_prompt = NULL,
				        optimized_prompt_version = NULL,
				        optimized_from_prompt_hash = NULL,
				        optimized_at_ms = NULL,
				        updated_at_ms = @nowMs
				  WHERE public_id = @id`,
			)
			.run({ id, nowMs });
		return this.getById(id);
	}

	getById(id: string): UserTag | null {
		const row = this.db
			.prepare(`${TAG_SELECT} WHERE tags.public_id = ?`)
			.get(id) as Row | undefined;
		return row ? rowToTag(row) : null;
	}

	listByAccount(accountId: string): UserTag[] {
		const rows = this.db
			.prepare(
				`${TAG_SELECT} WHERE accounts.public_id = @accountId ORDER BY tags.created_at_ms DESC`,
			)
			.all({ accountId }) as Row[];
		return rows.map(rowToTag);
	}

	deleteById(id: string): number {
		const info = this.db
			.prepare(`DELETE FROM mail_user_tags WHERE public_id = ?`)
			.run(id);
		return info.changes;
	}

	deleteByName(input: { accountId: string; name: string }): number {
		const info = this.db
			.prepare(
				`DELETE FROM mail_user_tags WHERE account_id =
				 (SELECT id FROM mail_accounts WHERE public_id = @accountId) AND name_norm = @nameNorm`,
			)
			.run({ accountId: input.accountId, nameNorm: normalizeTagName(input.name) });
		return info.changes;
	}
}

function normalizeTagName(name: string): string {
	return name.trim().toLocaleLowerCase();
}

function parseTime(value: string): number {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new Error("invalid-user-tag-time");
	return parsed;
}

export function defaultSmartTagPrompt(name: string, description: string): string {
	const cleanName = name.trim();
	const cleanDescription = description.trim();
	return [
		`判断一封邮件是否应该归入智能标签「${cleanName}」。`,
		cleanDescription
			? `标签描述：${cleanDescription}`
			: "标签描述：用户尚未填写详细描述，请根据标签名称谨慎判断。",
		"只有当邮件主题、正文、发件人或上下文明确匹配该描述时才应用此标签；不确定时不要应用。",
	].join("\n");
}

export function smartTagPromptHash(prompt: string): string {
	return createHash("sha256").update(prompt.trim()).digest("hex");
}
