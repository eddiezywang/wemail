import type Database from "better-sqlite3";

const CREATE_AGENT_PERSISTENCE_TABLES = `
  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    message_id TEXT,
    state TEXT NOT NULL CHECK(state IN (
      'queued', 'running', 'retrying', 'stopping', 'stopped',
      'failed', 'interrupted', 'settled'
    )),
    last_sequence INTEGER NOT NULL DEFAULT -1,
    started_at TEXT,
    settled_at TEXT,
    interrupted_at TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(conversation_id) REFERENCES agent_conversations(id) ON DELETE CASCADE,
    FOREIGN KEY(message_id) REFERENCES agent_messages(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation_state
  ON agent_runs(conversation_id, state, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_agent_runs_active
  ON agent_runs(state, created_at)
  WHERE state IN ('queued', 'running', 'retrying', 'stopping');

  CREATE TABLE IF NOT EXISTS agent_tool_executions (
    tool_call_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    input_json TEXT,
    output_json TEXT,
    state TEXT NOT NULL CHECK(state IN (
      'receiving_args', 'ready', 'running', 'completed', 'failed'
    )),
    summary TEXT,
    error_code TEXT,
    started_at TEXT,
    ended_at TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_agent_tool_executions_run
  ON agent_tool_executions(run_id, updated_at);

  CREATE TABLE IF NOT EXISTS agent_followup_queue (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    text TEXT NOT NULL,
    attachment_ids_json TEXT NOT NULL DEFAULT '[]',
    position INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN (
      'queued', 'paused', 'running', 'completed', 'removed'
    )),
    pause_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(conversation_id) REFERENCES agent_conversations(id) ON DELETE CASCADE
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_followup_queue_position
  ON agent_followup_queue(conversation_id, position)
  WHERE state != 'removed';

  CREATE TABLE IF NOT EXISTS agent_citations (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    part_id TEXT,
    source_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(message_id) REFERENCES agent_messages(id) ON DELETE CASCADE,
    FOREIGN KEY(run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS agent_attachments (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    source_key TEXT NOT NULL,
    name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(account_id, source_key)
  );

  CREATE TABLE IF NOT EXISTS agent_attachment_refs (
    attachment_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY(attachment_id, message_id),
    FOREIGN KEY(attachment_id) REFERENCES agent_attachments(id) ON DELETE CASCADE,
    FOREIGN KEY(message_id) REFERENCES agent_messages(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_agent_attachment_refs_message
  ON agent_attachment_refs(message_id, position);

  CREATE TABLE IF NOT EXISTS agent_user_behavior_events (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN (
      'user_input', 'user_edit', 'user_confirmed', 'user_rejected', 'mail_action'
    )),
    conversation_id TEXT,
    run_id TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_agent_user_behavior_events_account
  ON agent_user_behavior_events(account_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS agent_user_preferences (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    preference_key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    provenance_event_ids_json TEXT NOT NULL DEFAULT '[]',
    confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
    last_confirmed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(account_id, preference_key)
  );
`;

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((entry) => entry.name === column);
}

function addColumn(
  db: Database.Database,
  table: string,
  column: string,
  declaration: string,
): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}

/**
 * Installs the Pi-independent Agent persistence schema for existing local
 * databases and fresh canonical desktop databases. The column checks make
 * repeated startup calls safe without retaining raw runtime-event storage.
 */
export function ensureAgentPersistenceSchema(db: Database.Database): void {
  const messagesTable = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_messages'",
  ).get();
  if (!messagesTable) return;
  db.transaction(() => {
    addColumn(db, "agent_messages", "run_id", "TEXT");
    addColumn(db, "agent_messages", "parts_json", "TEXT NOT NULL DEFAULT '[]'");
    addColumn(db, "agent_messages", "markdown_source", "TEXT NOT NULL DEFAULT ''");
    addColumn(db, "agent_messages", "attachment_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    addColumn(db, "agent_messages", "updated_at", "TEXT");
    const pendingActionsTable = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_pending_actions'",
    ).get();
    if (pendingActionsTable) {
      addColumn(db, "agent_pending_actions", "expires_at", "TEXT");
      addColumn(db, "agent_pending_actions", "idempotency_key", "TEXT");
      addColumn(db, "agent_pending_actions", "parameter_hash", "TEXT");
      addColumn(db, "agent_pending_actions", "displayed_parameters_json", "TEXT");
      addColumn(db, "agent_pending_actions", "execution_state", "TEXT NOT NULL DEFAULT 'not_started'");
      addColumn(db, "agent_pending_actions", "execution_result_json", "TEXT");
      addColumn(db, "agent_pending_actions", "execution_started_at", "TEXT");
      addColumn(db, "agent_pending_actions", "execution_completed_at", "TEXT");
      const durableExecutions = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_action_executions'").get();
      db.exec(`
        UPDATE agent_pending_actions
           SET displayed_parameters_json = COALESCE(displayed_parameters_json, input_json),
               idempotency_key = COALESCE(idempotency_key, 'legacy:' || id),
               expires_at = COALESCE(expires_at, datetime(created_at, '+24 hours'))
         WHERE displayed_parameters_json IS NULL OR idempotency_key IS NULL OR expires_at IS NULL;
        UPDATE agent_pending_actions
           SET status = 'confirmed',
               resolved_at = COALESCE(resolved_at, execution_completed_at, created_at)
         WHERE status IN ('pending', 'expired')
           AND execution_state IN ('failed', 'outcome_unknown');
        UPDATE agent_pending_actions
           SET status = 'confirmed',
               execution_state = 'outcome_unknown',
               resolved_at = COALESCE(resolved_at, execution_started_at, created_at),
               execution_completed_at = COALESCE(execution_completed_at, execution_started_at, created_at),
               execution_result_json = COALESCE(
                 execution_result_json,
                 '{"ok":false,"summary":"应用重启前的执行结果未知，请先核对实际结果。"}'
               )
         WHERE status = 'pending' AND execution_state = 'executing'
         ${durableExecutions ? "AND NOT EXISTS (SELECT 1 FROM agent_action_executions e WHERE e.action_id = agent_pending_actions.id)" : ""};
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_pending_actions_idempotency
        ON agent_pending_actions(account_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      `);
    }
    db.exec(CREATE_AGENT_PERSISTENCE_TABLES);
    addColumn(db, "agent_attachments", "source_type", "TEXT NOT NULL DEFAULT 'local'");
    addColumn(db, "agent_attachments", "source_json", "TEXT NOT NULL DEFAULT '{}'");
    addColumn(db, "agent_attachments", "parse_state", "TEXT NOT NULL DEFAULT 'ready'");
    addColumn(db, "agent_attachments", "parse_error", "TEXT");
    addColumn(db, "agent_attachments", "extracted_relative_path", "TEXT");
    addColumn(db, "agent_attachments", "page_count", "INTEGER");
    addColumn(db, "agent_attachments", "thumbnail_relative_path", "TEXT");
    addColumn(db, "agent_attachments", "image_width", "INTEGER");
    addColumn(db, "agent_attachments", "image_height", "INTEGER");
    addColumn(db, "agent_attachments", "character_count", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "agent_attachments", "unreferenced_at", "TEXT");
    addColumn(db, "agent_attachments", "updated_at", "TEXT");
  })();
}

export { CREATE_AGENT_PERSISTENCE_TABLES };
