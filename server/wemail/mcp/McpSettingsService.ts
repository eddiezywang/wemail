import type { MailDatabase } from "../database/Database.js";
import {
  WEMAIL_MCP_DEFAULT_BODY_CHARACTERS,
  WEMAIL_MCP_DEFAULT_MAX_BODY_CHARACTERS,
  WEMAIL_MCP_DEFAULT_MAX_BATCH_MESSAGES,
  WEMAIL_MCP_DEFAULT_MAX_PAGE_SIZE,
  WEMAIL_MCP_DEFAULT_MAX_PENDING_OPERATIONS,
  WEMAIL_MCP_DEFAULT_MAX_RECIPIENTS,
  WEMAIL_MCP_DEFAULT_PAGE_SIZE,
  WEMAIL_MCP_DEFAULT_PORT,
  WEMAIL_MCP_DEFAULT_TOOL_TIMEOUT_SECONDS,
  WEMAIL_MCP_MAX_BODY_CHARACTERS,
  WEMAIL_MCP_MAX_BATCH_MESSAGES,
  WEMAIL_MCP_MAX_PAGE_SIZE,
  WEMAIL_MCP_MAX_PENDING_OPERATIONS,
  WEMAIL_MCP_MAX_RECIPIENTS,
  WEMAIL_MCP_MAX_TOOL_TIMEOUT_SECONDS,
  type WemailMcpSettingsInput,
} from "../../../shared/wemail/mcp.js";

export interface McpSettings {
  enabled: boolean;
  port: number;
  defaultBodyCharacters: number;
  maxBodyCharacters: number;
  defaultPageSize: number;
  maxPageSize: number;
  maxRecipients: number;
  maxBatchMessages: number;
  maxPendingOperations: number;
  toolTimeoutSeconds: number;
  updatedAt?: string;
}

interface McpSettingsRow {
  enabled: number;
  port: number;
  default_body_characters: number;
  max_body_characters: number;
  default_page_size: number;
  max_page_size: number;
  max_recipients: number;
  max_batch_messages: number;
  max_pending_operations: number;
  tool_timeout_seconds: number;
  updated_at: string;
}

function assertInteger(value: number, minimum: number, maximum: number, name: string) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`invalid-mcp-${name}`);
}

export class McpSettingsService {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get(): McpSettings {
    const row = this.db.prepare(`
      SELECT enabled, port, default_body_characters, max_body_characters,
        default_page_size, max_page_size, max_recipients, max_batch_messages,
        max_pending_operations, tool_timeout_seconds, updated_at
      FROM mcp_settings WHERE id = 'default'
    `).get() as McpSettingsRow | undefined;
    return row
      ? {
          enabled: row.enabled === 1,
          port: row.port,
          defaultBodyCharacters: row.default_body_characters,
          maxBodyCharacters: row.max_body_characters,
          defaultPageSize: row.default_page_size,
          maxPageSize: row.max_page_size,
          maxRecipients: row.max_recipients,
          maxBatchMessages: row.max_batch_messages,
          maxPendingOperations: row.max_pending_operations,
          toolTimeoutSeconds: row.tool_timeout_seconds,
          updatedAt: row.updated_at,
        }
      : {
          enabled: false,
          port: WEMAIL_MCP_DEFAULT_PORT,
          defaultBodyCharacters: WEMAIL_MCP_DEFAULT_BODY_CHARACTERS,
          maxBodyCharacters: WEMAIL_MCP_DEFAULT_MAX_BODY_CHARACTERS,
          defaultPageSize: WEMAIL_MCP_DEFAULT_PAGE_SIZE,
          maxPageSize: WEMAIL_MCP_DEFAULT_MAX_PAGE_SIZE,
          maxRecipients: WEMAIL_MCP_DEFAULT_MAX_RECIPIENTS,
          maxBatchMessages: WEMAIL_MCP_DEFAULT_MAX_BATCH_MESSAGES,
          maxPendingOperations: WEMAIL_MCP_DEFAULT_MAX_PENDING_OPERATIONS,
          toolTimeoutSeconds: WEMAIL_MCP_DEFAULT_TOOL_TIMEOUT_SECONDS,
        };
  }

  save(input: WemailMcpSettingsInput): McpSettings {
    const next = { ...this.get(), ...input };
    assertInteger(next.port, 1, 65_535, "port");
    assertInteger(next.defaultBodyCharacters, 1, WEMAIL_MCP_MAX_BODY_CHARACTERS, "default-body-characters");
    assertInteger(next.maxBodyCharacters, 1, WEMAIL_MCP_MAX_BODY_CHARACTERS, "max-body-characters");
    assertInteger(next.defaultPageSize, 1, WEMAIL_MCP_MAX_PAGE_SIZE, "default-page-size");
    assertInteger(next.maxPageSize, 1, WEMAIL_MCP_MAX_PAGE_SIZE, "max-page-size");
    assertInteger(next.maxRecipients, 1, WEMAIL_MCP_MAX_RECIPIENTS, "max-recipients");
    assertInteger(next.maxBatchMessages, 1, WEMAIL_MCP_MAX_BATCH_MESSAGES, "max-batch-messages");
    assertInteger(next.maxPendingOperations, 1, WEMAIL_MCP_MAX_PENDING_OPERATIONS, "max-pending-operations");
    assertInteger(next.toolTimeoutSeconds, 1, WEMAIL_MCP_MAX_TOOL_TIMEOUT_SECONDS, "tool-timeout-seconds");
    if (next.defaultBodyCharacters > next.maxBodyCharacters) throw new Error("invalid-mcp-body-character-range");
    if (next.defaultPageSize > next.maxPageSize) throw new Error("invalid-mcp-page-size-range");
    const updatedAt = this.now().toISOString();
    this.db.prepare(`
      INSERT INTO mcp_settings (
        id, enabled, port, default_body_characters, max_body_characters,
        default_page_size, max_page_size, max_recipients, max_batch_messages,
        max_pending_operations, tool_timeout_seconds, updated_at
      ) VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        enabled = excluded.enabled, port = excluded.port,
        default_body_characters = excluded.default_body_characters,
        max_body_characters = excluded.max_body_characters,
        default_page_size = excluded.default_page_size,
        max_page_size = excluded.max_page_size,
        max_recipients = excluded.max_recipients,
        max_batch_messages = excluded.max_batch_messages,
        max_pending_operations = excluded.max_pending_operations,
        tool_timeout_seconds = excluded.tool_timeout_seconds,
        updated_at = excluded.updated_at
    `).run(
      next.enabled ? 1 : 0, next.port, next.defaultBodyCharacters,
      next.maxBodyCharacters, next.defaultPageSize, next.maxPageSize,
      next.maxRecipients, next.maxBatchMessages, next.maxPendingOperations,
      next.toolTimeoutSeconds, updatedAt,
    );
    return { ...next, updatedAt };
  }
}
