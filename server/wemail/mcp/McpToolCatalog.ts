import {
  WEMAIL_MCP_MAX_BODY_CHARACTERS,
  WEMAIL_MCP_MAX_BATCH_MESSAGES,
  WEMAIL_MCP_MAX_PAGE_SIZE,
  WEMAIL_MCP_MAX_RECIPIENTS,
  WEMAIL_MCP_V1_TOOL_NAMES,
  type WemailMcpToolDomain,
  type WemailMcpToolRisk,
  type WemailMcpV1ToolName,
} from "../../../shared/wemail/mcp.js";

export type McpJsonSchema = {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string;
  properties?: Record<string, McpJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: McpJsonSchema;
  enum?: Array<string | number | boolean | null>;
  const?: string | number | boolean | null;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  format?: string;
  oneOf?: McpJsonSchema[];
};

export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface WemailMcpToolDefinition {
  name: WemailMcpV1ToolName;
  title: string;
  description: string;
  domain: WemailMcpToolDomain;
  risk: WemailMcpToolRisk;
  annotations: McpToolAnnotations;
  maxResponseBytes: number;
  inputSchema: McpJsonSchema;
  outputSchema: McpJsonSchema;
}

const string = (options: Omit<McpJsonSchema, "type"> = {}): McpJsonSchema => ({
  type: "string",
  ...options,
});
const integer = (minimum: number, maximum: number): McpJsonSchema => ({
  type: "integer",
  minimum,
  maximum,
});
const boolean = (): McpJsonSchema => ({ type: "boolean" });
const array = (items: McpJsonSchema, maxItems?: number): McpJsonSchema => ({
  type: "array",
  items,
  ...(maxItems === undefined ? {} : { maxItems }),
});
const object = (
  properties: Record<string, McpJsonSchema>,
  required: string[] = [],
): McpJsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const pagedInput = (
  properties: Record<string, McpJsonSchema>,
  required: string[] = [],
  maxPageSize = WEMAIL_MCP_MAX_PAGE_SIZE,
) =>
  object(
    {
      ...properties,
      cursor: string({ minLength: 1, maxLength: 4096 }),
      pageSize: integer(1, maxPageSize),
    },
    required,
  );

const address = object(
  {
    name: string({ minLength: 1, maxLength: 512 }),
    email: string({ format: "email", maxLength: 320 }),
  },
  ["email"],
);
const uploadAttachmentReference = object(
  { uploadRef: string({ minLength: 1, maxLength: 256 }) },
  ["uploadRef"],
);
const existingAttachmentReference = object(
  { attachmentId: string({ minLength: 1, maxLength: 2048 }) },
  ["attachmentId"],
);
const attachmentReference: McpJsonSchema = {
  oneOf: [
    uploadAttachmentReference,
    existingAttachmentReference,
  ],
};
const attachmentMetadataOutput = object(
  {
    id: string({ minLength: 1, maxLength: 2048, description: "Opaque attachment identifier; message attachment ids are passed to get_mail_attachment as attachmentId." }),
    filename: string({ minLength: 1, maxLength: 1024 }),
    mimeType: string({ minLength: 1, maxLength: 255 }),
    size: integer(0, Number.MAX_SAFE_INTEGER),
    contentId: string({ maxLength: 2048 }),
    disposition: string({ enum: ["inline", "attachment"] }),
  },
  ["id", "filename", "mimeType", "size"],
);
const messageDetailOutput = object(
  {
    id: string(),
    accountId: string(),
    threadId: string(),
    folder: string(),
    from: address,
    to: array(address),
    cc: array(address),
    bcc: array(address),
    receivedAt: string({ format: "date-time" }),
    subject: string(),
    snippet: string(),
    attachments: array(attachmentMetadataOutput),
    bodyText: string({ maxLength: WEMAIL_MCP_MAX_BODY_CHARACTERS }),
    bodyHtml: string({ maxLength: WEMAIL_MCP_MAX_BODY_CHARACTERS }),
    truncated: boolean(),
    contentTrust: string({ const: "untrusted-provider-content" }),
  },
  ["id", "accountId", "subject", "snippet", "bodyText", "truncated", "contentTrust"],
);
const mailFlagsOutput = object(
  { seen: boolean(), flagged: boolean(), answered: boolean(), draft: boolean() },
  ["seen", "flagged", "answered", "draft"],
);
const mailEnvelopeOutput = object(
  {
    id: string(),
    accountId: string(),
    threadId: string(),
    folder: string(),
    from: address,
    subject: string(),
    snippet: string(),
    receivedAt: string({ format: "date-time" }),
    flags: mailFlagsOutput,
    hasAttachments: boolean(),
  },
  ["id", "accountId", "folder", "from", "subject", "snippet", "receivedAt", "flags", "hasAttachments"],
);
const mailContentInput = (attachmentItem: McpJsonSchema) => ({
  mode: string({ enum: ["new", "reply", "reply_all", "forward"] }),
  sourceMessageId: string({ minLength: 1, maxLength: 2048 }),
  threadId: string({ minLength: 1, maxLength: 2048 }),
  to: array(address, WEMAIL_MCP_MAX_RECIPIENTS),
  cc: array(address, WEMAIL_MCP_MAX_RECIPIENTS),
  bcc: array(address, WEMAIL_MCP_MAX_RECIPIENTS),
  subject: string({ maxLength: 998 }),
  bodyText: string({ maxLength: 1_000_000 }),
  bodyHtml: string({ maxLength: 1_000_000 }),
  attachments: {
    ...array(attachmentItem, 20),
    description: "The complete ordered attachment set, using staged uploadRef values and, for an existing draft, its attachmentId values.",
  },
});

const accountId = string({ minLength: 1, maxLength: 256 });
const entityId = string({ minLength: 1, maxLength: 2048 });
const cursorOutput = { nextCursor: string({ minLength: 1, maxLength: 4096 }) };
const okOutput = object({ ok: boolean() }, ["ok"]);
const accountOutput = object(
  {
    accounts: array(
      object(
        {
          id: string(),
          provider: string(),
          email: string(),
          displayName: string(),
          capabilities: object(
            {
              schemaVersion: integer(1, 1),
              folderModel: string({ enum: ["folders", "labels", "hybrid"] }),
              threading: string({ enum: ["native", "synthesized", "none"] }),
              serverSearch: boolean(),
              providerDrafts: boolean(),
              sendAs: boolean(),
              outboundAttachments: boolean(),
              syncMode: string({ enum: ["full", "cursor", "delta"] }),
              realtimeMode: string({ enum: ["idle", "push", "poll", "none"] }),
              maxAttachmentBytes: integer(0, 100_000_000),
              maxRecipients: integer(1, 1000),
            },
            [
              "schemaVersion",
              "folderModel",
              "threading",
              "serverSearch",
              "providerDrafts",
              "sendAs",
              "outboundAttachments",
              "syncMode",
              "realtimeMode",
              "maxAttachmentBytes",
              "maxRecipients",
            ],
          ),
        },
        ["id", "provider", "email", "capabilities"],
      ),
    ),
  },
  ["accounts"],
);
const operationOutput = object(
  {
    operation: object(
      {
        id: string(),
        accountId: string(),
        type: string({ enum: ["send", "mail_action", "delete_draft", "delete_todo"] }),
        state: string({
          enum: [
            "prepared",
            "awaiting_confirmation",
            "approved",
            "committing",
            "succeeded",
            "failed_retryable",
            "cancelled",
            "expired",
            "outcome_unknown",
          ],
        }),
        preview: string({ maxLength: 4000 }),
        payloadHash: string({ minLength: 16, maxLength: 256 }),
        createdAt: string({ format: "date-time" }),
        updatedAt: string({ format: "date-time" }),
        expiresAt: string({ format: "date-time" }),
        executed: boolean(),
        retryable: boolean(),
        resultCode: string({ maxLength: 128 }),
      },
      ["id", "accountId", "type", "state", "createdAt", "expiresAt"],
    ),
  },
  ["operation"],
);
const todoRecordOutput = object(
  {
    id: string(), accountId: string(), title: string(), description: string({ maxLength: 20_000 }),
    priority: string({ enum: ["low", "medium", "high"] }),
    status: string({ enum: ["suggested", "confirmed", "completed"] }), done: boolean(),
    startTime: string({ format: "date-time" }), dueTime: string({ format: "date-time" }), timezone: string(),
    source: string({ enum: ["ai", "user", "agent", "mcp"] }), messageId: string(),
    mail: object({ id: string(), threadId: string(), subject: string(), from: address, receivedAt: string({ format: "date-time" }) }, ["id", "subject", "from", "receivedAt"]),
    createdAt: string({ format: "date-time" }), updatedAt: string({ format: "date-time" }),
  },
  ["id", "accountId", "title", "priority", "status", "done", "source", "createdAt", "updatedAt"],
);
type CatalogSeed = Omit<WemailMcpToolDefinition, "name" | "annotations">;

const seeds: Record<WemailMcpV1ToolName, CatalogSeed> = {
  list_mail_accounts: {
    title: "List mail accounts",
    description: "List non-secret account identity and provider capabilities available in WeMail.",
    domain: "discovery",
    risk: "read",
    maxResponseBytes: 64_000,
    inputSchema: object({}),
    outputSchema: accountOutput,
  },
  list_mail_folders: {
    title: "List mail folders",
    description: "List provider folders or labels for one owned mail account.",
    domain: "discovery",
    risk: "read",
    maxResponseBytes: 128_000,
    inputSchema: object({ accountId }, ["accountId"]),
    outputSchema: object(
      {
        folders: array(
          object(
            {
              id: string(),
              name: string(),
              role: string({ enum: ["inbox", "sent", "drafts", "archive", "trash", "spam", "system", "custom"] }),
              selectable: boolean(),
              model: string({ enum: ["folder", "label"] }),
            },
            ["id", "name", "role", "selectable", "model"],
          ),
        ),
      },
      ["folders"],
    ),
  },
  sync_mail_account: {
    title: "Synchronize mail account",
    description: "Request bounded synchronization through WeMail's existing account coordinator.",
    domain: "discovery",
    risk: "local-write",
    maxResponseBytes: 32_000,
    inputSchema: object({ accountId, folderId: entityId }, ["accountId"]),
    outputSchema: object({ sync: object({ id: string(), state: string(), phase: string(), processed: integer(0, Number.MAX_SAFE_INTEGER), updatedAt: string({ format: "date-time" }) }, ["id", "state", "phase", "processed", "updatedAt"]) }, ["sync"]),
  },
  get_mail_sync_status: {
    title: "Get mail sync status",
    description: "Read bounded progress for a synchronization request.",
    domain: "discovery",
    risk: "read",
    maxResponseBytes: 32_000,
    inputSchema: object({ syncId: entityId }, ["syncId"]),
    outputSchema: object({ sync: object({ id: string(), accountId: string(), folderId: string(), state: string(), phase: string(), processed: integer(0, Number.MAX_SAFE_INTEGER), total: integer(0, Number.MAX_SAFE_INTEGER), checkpoint: string(), errorCode: string(), updatedAt: string({ format: "date-time" }) }, ["id", "accountId", "state", "phase", "processed", "updatedAt"]) }, ["sync"]),
  },
  list_mail_messages: {
    title: "List mail messages",
    description: "List body-free envelope summaries with bounded cursor pagination.",
    domain: "read",
    risk: "read",
    maxResponseBytes: 16 * 1024 * 1024,
    inputSchema: pagedInput({ accountId, folderId: entityId, unreadOnly: boolean(), after: string({ format: "date-time" }), before: string({ format: "date-time" }) }, ["accountId", "folderId"]),
    outputSchema: object({ items: array(mailEnvelopeOutput, WEMAIL_MCP_MAX_PAGE_SIZE), ...cursorOutput }, ["items"]),
  },
  search_mail: {
    title: "Search mail",
    description: "Search mail using provider or explicitly identified bounded local semantics; returns envelopes only.",
    domain: "read",
    risk: "read",
    maxResponseBytes: 16 * 1024 * 1024,
    inputSchema: pagedInput({ accountId, query: string({ minLength: 1, maxLength: 4000 }), folderId: entityId }, ["accountId", "query"]),
    outputSchema: object({ mode: string({ enum: ["provider", "local"] }), items: array(mailEnvelopeOutput, WEMAIL_MCP_MAX_PAGE_SIZE), ...cursorOutput }, ["mode", "items"]),
  },
  get_mail_message: {
    title: "Get mail message",
    description: "Read one targeted message with bounded untrusted body content.",
    domain: "read",
    risk: "read",
    maxResponseBytes: 16 * 1024 * 1024,
    inputSchema: object({ accountId, messageId: entityId, maxBodyCharacters: integer(1, WEMAIL_MCP_MAX_BODY_CHARACTERS), includeHtml: boolean() }, ["accountId", "messageId"]),
    outputSchema: object({ message: messageDetailOutput }, ["message"]),
  },
  get_mail_thread: {
    title: "Get mail thread",
    description: "Read a bounded page of targeted thread messages with untrusted body content.",
    domain: "read",
    risk: "read",
    maxResponseBytes: 16 * 1024 * 1024,
    inputSchema: pagedInput({ accountId, threadId: entityId, maxBodyCharacters: integer(1, WEMAIL_MCP_MAX_BODY_CHARACTERS), includeHtml: boolean() }, ["accountId", "threadId"]),
    outputSchema: object({ accountId: string(), threadId: string(), messages: array(messageDetailOutput, WEMAIL_MCP_MAX_PAGE_SIZE), ...cursorOutput }, ["accountId", "threadId", "messages"]),
  },
  get_mail_attachment: {
    title: "Get mail attachment",
    description: "Fetch one owned attachment by the id returned from get_mail_message or get_mail_thread as a session-bound embedded MCP resource.",
    domain: "attachment",
    risk: "read",
    maxResponseBytes: 35 * 1024 * 1024,
    inputSchema: object({ accountId, messageId: entityId, attachmentId: entityId }, ["accountId", "messageId", "attachmentId"]),
    outputSchema: object({ resource: object({ uri: string(), filename: string(), mimeType: string(), size: integer(0, 25 * 1024 * 1024), sessionBound: boolean() }, ["uri", "filename", "mimeType", "size", "sessionBound"]) }, ["resource"]),
  },
  upload_mail_attachment: {
    title: "Upload mail attachment",
    description: "Stage one bounded attachment in memory for this MCP session. Draft persistence and sending with attachments are currently unsupported.",
    domain: "attachment",
    risk: "local-write",
    maxResponseBytes: 16_000,
    inputSchema: object({
      accountId,
      filename: string({ minLength: 1, maxLength: 1024 }),
      mimeType: string({ minLength: 1, maxLength: 255 }),
      size: integer(0, 25 * 1024 * 1024),
      dataBase64: string({ minLength: 1, maxLength: 34_952_536 }),
    }, ["accountId", "filename", "mimeType", "size", "dataBase64"]),
    outputSchema: object({
      uploadRef: string({ minLength: 1, maxLength: 256 }),
      attachment: object({
        filename: string(),
        mimeType: string(),
        size: integer(0, 25 * 1024 * 1024),
      }, ["filename", "mimeType", "size"]),
      expiresAt: string({ format: "date-time" }),
    }, ["uploadRef", "attachment", "expiresAt"]),
  },
  list_mail_drafts: {
    title: "List mail drafts",
    description: "List paginated draft metadata and bounded body excerpts.",
    domain: "draft",
    risk: "read",
    maxResponseBytes: 16 * 1024 * 1024,
    inputSchema: pagedInput({ accountId }, ["accountId"]),
    outputSchema: object({ drafts: array(object({ id: string(), accountId: string(), mode: string(), subject: string(), bodyExcerpt: string({ maxLength: 240 }), updatedAt: string({ format: "date-time" }) }, ["id", "accountId", "mode", "subject", "bodyExcerpt", "updatedAt"]), WEMAIL_MCP_MAX_PAGE_SIZE), ...cursorOutput }, ["drafts"]),
  },
  get_mail_draft: {
    title: "Get mail draft",
    description: "Read one targeted owned draft.",
    domain: "draft",
    risk: "read",
    maxResponseBytes: 16 * 1024 * 1024,
    inputSchema: object({ accountId, draftId: entityId }, ["accountId", "draftId"]),
    outputSchema: object({ draft: object({ id: string(), accountId: string(), mode: string({ enum: ["new", "reply", "forward"] }), sourceMessageId: string(), to: array(address), cc: array(address), bcc: array(address), subject: string(), bodyText: string({ maxLength: 1_000_000 }), bodyHtml: string({ maxLength: 1_000_000 }), attachments: array(attachmentMetadataOutput), createdAt: string({ format: "date-time" }), updatedAt: string({ format: "date-time" }) }, ["id", "accountId", "mode", "subject", "bodyText", "updatedAt"]) }, ["draft"]),
  },
  create_mail_draft: {
    title: "Create mail draft",
    description: "Create an unsent draft without attachments. This tool cannot dispatch mail.",
    domain: "draft",
    risk: "local-write",
    maxResponseBytes: 64_000,
    inputSchema: object({ accountId, ...mailContentInput(uploadAttachmentReference) }, ["accountId", "mode"]),
    outputSchema: object({ draft: object({ id: string(), accountId: string(), subject: string(), updatedAt: string({ format: "date-time" }), sent: boolean() }, ["id", "accountId", "subject", "updatedAt", "sent"]) }, ["draft"]),
  },
  update_mail_draft: {
    title: "Update mail draft",
    description: "Update an owned unsent draft without attachments. This tool cannot dispatch mail.",
    domain: "draft",
    risk: "local-write",
    maxResponseBytes: 64_000,
    inputSchema: object({ accountId, draftId: entityId, ...mailContentInput(attachmentReference) }, ["accountId", "draftId"]),
    outputSchema: object({ draft: object({ id: string(), accountId: string(), subject: string(), updatedAt: string({ format: "date-time" }), sent: boolean() }, ["id", "accountId", "subject", "updatedAt", "sent"]) }, ["draft"]),
  },
  set_mail_state: {
    title: "Set mail state",
    description: "Directly apply one reversible read/unread/star/unstar state change to one message.",
    domain: "operation",
    risk: "local-write",
    maxResponseBytes: 64_000,
    inputSchema: object({ accountId, messageId: entityId, action: string({ enum: ["mark_read", "mark_unread", "star", "unstar"] }) }, ["accountId", "messageId", "action"]),
    outputSchema: object({ messageId: string(), action: string(), flags: object({ seen: boolean(), flagged: boolean() }, ["seen", "flagged"]) }, ["messageId", "action", "flags"]),
  },
  prepare_mail_actions: {
    title: "Prepare mail actions",
    description: "Validate and prepare a mailbox mutation for idempotent commit without executing it.",
    domain: "operation",
    risk: "prepared-high-risk",
    maxResponseBytes: 128_000,
    inputSchema: object({ accountId, action: string({ enum: ["archive", "move", "trash", "restore", "spam", "unspam", "delete_forever"] }), messageIds: { ...array(entityId, WEMAIL_MCP_MAX_BATCH_MESSAGES), minItems: 1 }, destinationFolderId: entityId }, ["accountId", "action", "messageIds"]),
    outputSchema: operationOutput,
  },
  prepare_mail_send: {
    title: "Prepare mail send",
    description: "Validate and prepare a send without attachments for idempotent commit without executing it.",
    domain: "operation",
    risk: "prepared-high-risk",
    maxResponseBytes: 128_000,
    inputSchema: object({ accountId, draftId: entityId, ...mailContentInput(attachmentReference) }, ["accountId", "mode"]),
    outputSchema: operationOutput,
  },
  commit_mail_operation: {
    title: "Commit prepared mail operation",
    description: "Commit a prepared operation using a durable idempotency reservation, without an additional WeMail confirmation. A successful send commit means queued for delivery, not delivered.",
    domain: "operation",
    risk: "commit-high-risk",
    maxResponseBytes: 128_000,
    inputSchema: object({ operationId: entityId, idempotencyKey: string({ minLength: 8, maxLength: 256 }) }, ["operationId", "idempotencyKey"]),
    outputSchema: operationOutput,
  },
  get_mail_operation_status: {
    title: "Get mail operation status",
    description: "Read the durable state of one prepared or committed operation.",
    domain: "operation",
    risk: "read",
    maxResponseBytes: 64_000,
    inputSchema: object({ operationId: entityId }, ["operationId"]),
    outputSchema: operationOutput,
  },
  cancel_mail_operation: {
    title: "Cancel mail operation",
    description: "Cancel a prepared operation before commit reservation.",
    domain: "operation",
    risk: "local-write",
    maxResponseBytes: 64_000,
    inputSchema: object({ operationId: entityId }, ["operationId"]),
    outputSchema: operationOutput,
  },
  list_todos: {
    title: "List todos",
    description: "List account-scoped mail-linked todos without source mail bodies.",
    domain: "todo",
    risk: "read",
    maxResponseBytes: 16 * 1024 * 1024,
    inputSchema: pagedInput({ accountId, status: string({ enum: ["suggested", "confirmed", "completed"] }), priority: string({ enum: ["low", "medium", "high"] }), dueAfter: string({ format: "date-time" }), dueBefore: string({ format: "date-time" }), messageId: entityId }, ["accountId"]),
    outputSchema: object({ todos: array(todoRecordOutput, WEMAIL_MCP_MAX_PAGE_SIZE), ...cursorOutput }, ["todos"]),
  },
  get_todo: {
    title: "Get todo",
    description: "Read one owned mail-linked todo without source mail body content.",
    domain: "todo",
    risk: "read",
    maxResponseBytes: 64_000,
    inputSchema: object({ accountId, todoId: entityId }, ["accountId", "todoId"]),
    outputSchema: object({ todo: todoRecordOutput }, ["todo"]),
  },
  create_todo: {
    title: "Create todo",
    description: "Create an account-scoped local todo with optional owned mail provenance.",
    domain: "todo",
    risk: "local-write",
    maxResponseBytes: 64_000,
    inputSchema: object({ accountId, title: string({ minLength: 1, maxLength: 1000 }), description: string({ maxLength: 20_000 }), priority: string({ enum: ["low", "medium", "high"] }), startTime: string({ format: "date-time" }), dueTime: string({ format: "date-time" }), timezone: string({ maxLength: 128 }), messageId: entityId }, ["accountId", "title"]),
    outputSchema: object({ todo: todoRecordOutput }, ["todo"]),
  },
  update_todo: {
    title: "Update todo",
    description: "Update fields on one owned local todo.",
    domain: "todo",
    risk: "local-write",
    maxResponseBytes: 64_000,
    inputSchema: object({ accountId, todoId: entityId, title: string({ minLength: 1, maxLength: 1000 }), description: string({ maxLength: 20_000 }), priority: string({ enum: ["low", "medium", "high"] }), startTime: string({ format: "date-time" }), dueTime: string({ format: "date-time" }), timezone: string({ maxLength: 128 }) }, ["accountId", "todoId"]),
    outputSchema: object({ todo: todoRecordOutput }, ["todo"]),
  },
  complete_todo: {
    title: "Complete todo",
    description: "Complete one owned todo through its reversible lifecycle.",
    domain: "todo",
    risk: "local-write",
    maxResponseBytes: 64_000,
    inputSchema: object({ accountId, todoId: entityId }, ["accountId", "todoId"]),
    outputSchema: object({ todo: todoRecordOutput }, ["todo"]),
  },
  restore_todo: {
    title: "Restore todo",
    description: "Restore one owned completed todo through its reversible lifecycle.",
    domain: "todo",
    risk: "local-write",
    maxResponseBytes: 64_000,
    inputSchema: object({ accountId, todoId: entityId }, ["accountId", "todoId"]),
    outputSchema: object({ todo: todoRecordOutput }, ["todo"]),
  },
  prepare_delete_entity: {
    title: "Prepare entity deletion",
    description: "Validate and prepare deletion of one saved draft or todo for idempotent commit.",
    domain: "operation",
    risk: "prepared-high-risk",
    maxResponseBytes: 128_000,
    inputSchema: object({ accountId, entityType: string({ enum: ["draft", "todo"] }), entityId }, ["accountId", "entityType", "entityId"]),
    outputSchema: operationOutput,
  },
  get_mail_intelligence: {
    title: "Get mail intelligence",
    description: "Read the aggregated AI intelligence state for one owned message across all capabilities.",
    domain: "read",
    risk: "read",
    maxResponseBytes: 512_000,
    inputSchema: object({ accountId, messageId: entityId }, ["accountId", "messageId"]),
    outputSchema: object(
      {
        intelligence: object(
          {
            emailId: string(),
            summary: object(
              {
                status: string(),
                ready: boolean(),
                error: string({ maxLength: 1000 }),
                skipReason: string({ maxLength: 500 }),
                canRetry: boolean(),
                urgency: string({ enum: ["low", "medium", "high"] }),
                headline: string({ maxLength: 500 }),
                bullets: array(string({ maxLength: 500 }), 20),
                actionItems: array(string({ maxLength: 500 }), 20),
              },
              ["status", "ready"],
            ),
            tags: object(
              {
                status: string(),
                ready: boolean(),
                tagNames: array(string({ maxLength: 100 }), 50),
              },
              ["status", "ready"],
            ),
            replyDecision: object(
              {
                status: string(),
                ready: boolean(),
                shouldReply: boolean(),
                reason: string({ maxLength: 1000 }),
              },
              ["status", "ready"],
            ),
            replyDraft: object(
              {
                status: string(),
                ready: boolean(),
                draftMarkdown: string({ maxLength: 8000 }),
                truncated: boolean(),
                language: string({ maxLength: 32 }),
              },
              ["status", "ready"],
            ),
            todoExtraction: object(
              {
                status: string(),
                ready: boolean(),
                todoCount: integer(0, 100),
              },
              ["status", "ready"],
            ),
            linkExtraction: object(
              {
                status: string(),
                ready: boolean(),
                linkCount: integer(0, 100),
              },
              ["status", "ready"],
            ),
            translation: object(
              {
                status: string(),
                ready: boolean(),
                targetLanguage: string({ maxLength: 32 }),
                translatedText: string({ maxLength: 8000 }),
                truncated: boolean(),
              },
              ["status", "ready"],
            ),
          },
          ["emailId", "summary", "tags", "replyDecision", "replyDraft"],
        ),
      },
      ["intelligence"],
    ),
  },
  search_mail_semantic: {
    title: "Search mail semantically",
    description: "Search owned mail using natural-language semantic or lexical matching; returns ranked chunks.",
    domain: "read",
    risk: "read",
    maxResponseBytes: 16 * 1024 * 1024,
    inputSchema: object(
      {
        accountId,
        query: string({ minLength: 1, maxLength: 200 }),
        limit: integer(1, WEMAIL_MCP_MAX_PAGE_SIZE),
        offset: integer(0, Number.MAX_SAFE_INTEGER),
      },
      ["accountId", "query"],
    ),
    outputSchema: object(
      {
        mode: string({ enum: ["semantic", "lexical"] }),
        chunks: array(
          object(
            {
              emailId: string(),
              chunkId: string(),
              score: { type: "number", minimum: 0, maximum: 1 },
              snippet: string({ maxLength: 1000 }),
              messageId: string(),
              subject: string(),
              sender: string(),
              recipient: string(),
              receivedAt: string({ format: "date-time" }),
              folder: string(),
              read: boolean(),
              starred: boolean(),
              hasAttachments: boolean(),
            },
            ["emailId", "chunkId", "score", "snippet"],
          ),
          WEMAIL_MCP_MAX_PAGE_SIZE,
        ),
        totalChunks: integer(0, Number.MAX_SAFE_INTEGER),
      },
      ["mode", "chunks", "totalChunks"],
    ),
  },
  ask_mail_question: {
    title: "Ask mail question",
    description: "Answer a natural-language question about owned mail using cited evidence chunks.",
    domain: "read",
    risk: "read",
    maxResponseBytes: 16 * 1024 * 1024,
    inputSchema: object(
      {
        accountId,
        question: string({ minLength: 1, maxLength: 500 }),
        maxChunks: integer(1, WEMAIL_MCP_MAX_PAGE_SIZE),
      },
      ["accountId", "question"],
    ),
    outputSchema: object(
      {
        hasEvidence: boolean(),
        answer: string({ maxLength: 8000 }),
        truncated: boolean(),
        claims: array(
          object(
            {
              text: string({ maxLength: 2000 }),
              citations: array(
                object(
                  {
                    emailId: string(),
                    chunkId: string(),
                    quote: string({ maxLength: 1000 }),
                  },
                  ["emailId", "chunkId"],
                ),
                10,
              ),
            },
            ["text", "citations"],
          ),
          WEMAIL_MCP_MAX_PAGE_SIZE,
        ),
        mode: string({ enum: ["semantic", "lexical"] }),
        retrievedChunkCount: integer(0, Number.MAX_SAFE_INTEGER),
      },
      ["hasEvidence", "claims", "mode", "retrievedChunkCount"],
    ),
  },
  record_tag_feedback: {
    title: "Record tag feedback",
    description: "Record user confirm or reject feedback for one AI tag on an owned message; idempotent.",
    domain: "todo",
    risk: "local-write",
    maxResponseBytes: 16_000,
    inputSchema: object(
      {
        accountId,
        messageId: entityId,
        tag: string({ minLength: 1, maxLength: 64 }),
        action: string({ enum: ["confirm", "reject"] }),
      },
      ["accountId", "messageId", "tag", "action"],
    ),
    outputSchema: object(
      {
        messageId: string(),
        tag: string(),
        action: string({ enum: ["confirm", "reject"] }),
        recorded: boolean(),
      },
      ["messageId", "tag", "action", "recorded"],
    ),
  },
  list_agent_attention: {
    title: "List agent attention",
    description: "List agent runs needing attention for one owned account within a recent failure window.",
    domain: "read",
    risk: "read",
    maxResponseBytes: 256_000,
    inputSchema: object({ accountId }, ["accountId"]),
    outputSchema: object(
      {
        active: array(
          object(
            {
              id: string(),
              conversationId: string(),
              state: string(),
              lastSequence: integer(0, Number.MAX_SAFE_INTEGER),
              startedAt: string({ format: "date-time" }),
              settledAt: string({ format: "date-time" }),
              interruptedAt: string({ format: "date-time" }),
              errorCode: string({ maxLength: 128 }),
            },
            ["id", "conversationId", "state", "lastSequence"],
          ),
          50,
        ),
        failed: array(
          object(
            {
              id: string(),
              conversationId: string(),
              state: string(),
              lastSequence: integer(0, Number.MAX_SAFE_INTEGER),
              startedAt: string({ format: "date-time" }),
              settledAt: string({ format: "date-time" }),
              interruptedAt: string({ format: "date-time" }),
              errorCode: string({ maxLength: 128 }),
            },
            ["id", "conversationId", "state", "lastSequence"],
          ),
          50,
        ),
        pausedConversationIds: array(string(), 100),
        failureSince: string({ format: "date-time" }),
      },
      ["active", "failed", "pausedConversationIds", "failureSince"],
    ),
  },
  get_conversation_state: {
    title: "Get conversation state",
    description: "Read a bounded summary of one owned agent conversation including recent messages and runs.",
    domain: "read",
    risk: "read",
    maxResponseBytes: 256_000,
    inputSchema: object(
      {
        accountId,
        conversationId: string({ minLength: 1, maxLength: 128 }),
      },
      ["accountId", "conversationId"],
    ),
    outputSchema: object(
      {
        conversation: object(
          {
            conversationId: string(),
            messageCount: integer(0, Number.MAX_SAFE_INTEGER),
            runCount: integer(0, Number.MAX_SAFE_INTEGER),
            toolCount: integer(0, Number.MAX_SAFE_INTEGER),
            pendingConfirmationCount: integer(0, Number.MAX_SAFE_INTEGER),
            followupCount: integer(0, Number.MAX_SAFE_INTEGER),
            recentMessages: array(
              object(
                {
                  id: string(),
                  runId: string(),
                  role: string(),
                  state: string(),
                  createdAt: string({ format: "date-time" }),
                  textPreview: string({ maxLength: 500 }),
                },
                ["id", "role", "state", "createdAt"],
              ),
              20,
            ),
            runs: array(
              object(
                {
                  id: string(),
                  state: string(),
                  lastSequence: integer(0, Number.MAX_SAFE_INTEGER),
                  startedAt: string({ format: "date-time" }),
                  settledAt: string({ format: "date-time" }),
                  errorCode: string({ maxLength: 128 }),
                },
                ["id", "state", "lastSequence"],
              ),
              20,
            ),
            pendingConfirmations: array(
              object(
                {
                  id: string(),
                  actionType: string(),
                  description: string({ maxLength: 500 }),
                  riskLevel: string({ enum: ["low", "medium", "high"] }),
                  status: string(),
                  expiresAt: string({ format: "date-time" }),
                },
                ["id", "actionType", "status", "expiresAt"],
              ),
              20,
            ),
          },
          ["conversationId", "messageCount", "runCount", "toolCount", "pendingConfirmationCount", "followupCount"],
        ),
      },
      ["conversation"],
    ),
  },
  search_directory_contacts: {
    title: "Search directory contacts",
    description: "Search owned directory contacts by name, email, or pinyin; phone fields are stripped for privacy.",
    domain: "read",
    risk: "read",
    maxResponseBytes: 16 * 1024 * 1024,
    inputSchema: object(
      {
        accountId,
        query: string({ maxLength: 100 }),
        departmentId: string({ minLength: 1, maxLength: 256 }),
        limit: integer(1, WEMAIL_MCP_MAX_PAGE_SIZE),
        offset: integer(0, Number.MAX_SAFE_INTEGER),
      },
      ["accountId", "query"],
    ),
    outputSchema: object(
      {
        contacts: array(
          object(
            {
              id: string(),
              accountId: string(),
              name: string(),
              email: string(),
              aliases: array(string(), 20),
              departmentId: string(),
              departmentPath: string(),
              title: string({ maxLength: 256 }),
            },
            ["id", "accountId", "name", "email", "aliases"],
          ),
          50,
        ),
        total: integer(0, Number.MAX_SAFE_INTEGER),
        remoteAvailable: boolean(),
      },
      ["contacts", "total", "remoteAvailable"],
    ),
  },
};

const annotations: Record<WemailMcpV1ToolName, McpToolAnnotations> = {
  list_mail_accounts: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_mail_folders: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  sync_mail_account: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  get_mail_sync_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_mail_messages: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  search_mail: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_mail_message: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_mail_thread: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_mail_attachment: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  upload_mail_attachment: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  list_mail_drafts: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_mail_draft: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  create_mail_draft: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  update_mail_draft: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  set_mail_state: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  prepare_mail_actions: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  prepare_mail_send: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  commit_mail_operation: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  get_mail_operation_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  cancel_mail_operation: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  list_todos: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_todo: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  create_todo: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  update_todo: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  complete_todo: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  restore_todo: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  prepare_delete_entity: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  get_mail_intelligence: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  search_mail_semantic: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  ask_mail_question: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  record_tag_feedback: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_agent_attention: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_conversation_state: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  search_directory_contacts: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

export const WEMAIL_MCP_V1_TOOL_DEFINITIONS: readonly WemailMcpToolDefinition[] =
  WEMAIL_MCP_V1_TOOL_NAMES.map((name) => ({ name, ...seeds[name], annotations: annotations[name] }));

export const WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME = new Map(
  WEMAIL_MCP_V1_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]),
);
