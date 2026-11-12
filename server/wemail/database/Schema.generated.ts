// Canonical WeMail database schema. Do not edit generated blocks by hand.

export const MAIL_DATABASE_SCHEMA_VERSION = 6 as const;

export const MAIL_DATABASE_SCHEMA_BLOCKS = [
  // Source: design.md
  `CREATE TABLE db_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE db_commits (
  version INTEGER PRIMARY KEY,
  committed_at_ms INTEGER NOT NULL,
  source TEXT NOT NULL,
  change_count INTEGER NOT NULL CHECK (change_count >= 0)
) STRICT;

CREATE TABLE db_changes (
  commit_version INTEGER NOT NULL REFERENCES db_commits(version) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_public_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('insert','update','delete')),
  scope_hint TEXT,
  PRIMARY KEY (commit_version, ordinal)
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_db_changes_entity
  ON db_changes(entity_type, entity_public_id, commit_version DESC);`,

  // Source: design.md
  `CREATE TABLE mail_accounts (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  email_address TEXT NOT NULL,
  display_name TEXT,
  provider_kind TEXT NOT NULL,
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL CHECK (imap_port BETWEEN 1 AND 65535),
  imap_secure INTEGER NOT NULL CHECK (imap_secure IN (0,1)),
  imap_username TEXT NOT NULL,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL CHECK (smtp_port BETWEEN 1 AND 65535),
  smtp_secure INTEGER NOT NULL CHECK (smtp_secure IN (0,1)),
  smtp_username TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  credential_generation INTEGER NOT NULL CHECK (credential_generation >= 0),
  state TEXT NOT NULL CHECK (state IN ('active','paused','auth_required','disabled')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  row_version INTEGER NOT NULL
) STRICT;

CREATE TABLE mail_identities (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  address_norm TEXT NOT NULL,
  display_name TEXT,
  is_primary INTEGER NOT NULL CHECK (is_primary IN (0,1)),
  UNIQUE (account_id, address_norm)
) STRICT;

CREATE TABLE mail_folders (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  remote_path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN
    ('inbox','sent','drafts','trash','junk','archive','all','custom')),
  delimiter TEXT,
  uid_validity INTEGER,
  highest_modseq INTEGER,
  is_selectable INTEGER NOT NULL CHECK (is_selectable IN (0,1)),
  is_subscribed INTEGER NOT NULL CHECK (is_subscribed IN (0,1)),
  deleted_at_ms INTEGER,
  row_version INTEGER NOT NULL,
  UNIQUE (account_id, remote_path)
) STRICT;

CREATE TABLE mail_folder_sync_state (
  folder_id INTEGER PRIMARY KEY REFERENCES mail_folders(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  cursor_json TEXT,
  last_success_at_ms INTEGER,
  last_error_code TEXT,
  retry_at_ms INTEGER,
  row_version INTEGER NOT NULL
) STRICT;

CREATE TABLE mail_sync_runs (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  folder_id INTEGER REFERENCES mail_folders(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running','succeeded','failed','cancelled')),
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  scanned_count INTEGER NOT NULL DEFAULT 0,
  changed_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT
) STRICT;`,

  // Source: design.md
  `CREATE TABLE mail_threads (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  normalized_subject TEXT NOT NULL,
  latest_received_at_ms INTEGER NOT NULL,
  message_count INTEGER NOT NULL CHECK (message_count >= 0),
  unread_count INTEGER NOT NULL CHECK (unread_count >= 0),
  row_version INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_mail_threads_latest
  ON mail_threads(account_id, latest_received_at_ms DESC, id DESC);

CREATE TABLE mail_message_id_sequences (
  received_at_ms INTEGER PRIMARY KEY,
  next_sequence INTEGER NOT NULL
    CHECK (next_sequence BETWEEN 0 AND 1048576)
) STRICT;

CREATE TABLE mail_messages (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  thread_id INTEGER REFERENCES mail_threads(id) ON DELETE SET NULL,
  rfc_message_id TEXT,
  normalized_subject TEXT NOT NULL,
  subject TEXT NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  sender_preview TEXT NOT NULL DEFAULT '',
  recipient_preview TEXT NOT NULL DEFAULT '',
  sent_at_ms INTEGER,
  received_at_ms INTEGER NOT NULL,
  internal_date_ms INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  has_attachments INTEGER NOT NULL DEFAULT 0 CHECK (has_attachments IN (0,1)),
  is_seen INTEGER NOT NULL DEFAULT 0 CHECK (is_seen IN (0,1)),
  is_flagged INTEGER NOT NULL DEFAULT 0 CHECK (is_flagged IN (0,1)),
  importance INTEGER NOT NULL DEFAULT 0,
  primary_instance_id INTEGER,
  primary_folder_id INTEGER REFERENCES mail_folders(id) ON DELETE SET NULL,
  content_version INTEGER NOT NULL DEFAULT 0,
  snoozed_until_ms INTEGER,
  row_version INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  ai_initial_summary_scope INTEGER NOT NULL DEFAULT 0
    CHECK (ai_initial_summary_scope IN (0,1,2))
) STRICT;

CREATE INDEX idx_mail_messages_all_time
  ON mail_messages(account_id, received_at_ms DESC, id DESC)
  WHERE deleted_at_ms IS NULL;
CREATE INDEX idx_mail_messages_unread_time
  ON mail_messages(account_id, received_at_ms DESC, id DESC)
  WHERE deleted_at_ms IS NULL AND is_seen = 0;
CREATE INDEX idx_mail_messages_flagged_time
  ON mail_messages(account_id, received_at_ms DESC, id DESC)
  WHERE deleted_at_ms IS NULL AND is_flagged = 1;
CREATE INDEX idx_mail_messages_attachment_time
  ON mail_messages(account_id, received_at_ms DESC, id DESC)
  WHERE deleted_at_ms IS NULL AND has_attachments = 1;
CREATE INDEX idx_mail_messages_thread_time
  ON mail_messages(thread_id, received_at_ms ASC, id ASC)
  WHERE deleted_at_ms IS NULL;
CREATE INDEX idx_mail_messages_rfc_id
  ON mail_messages(account_id, rfc_message_id)
  WHERE rfc_message_id IS NOT NULL;
CREATE INDEX idx_mail_messages_snoozed
  ON mail_messages(account_id, snoozed_until_ms, received_at_ms DESC)
  WHERE deleted_at_ms IS NULL AND snoozed_until_ms IS NOT NULL;

CREATE TABLE mail_message_identity_keys (
  message_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  key_kind TEXT NOT NULL CHECK (key_kind IN
    ('rfc_message_id','strong_fingerprint','structural_fingerprint','legacy')),
  key_value TEXT NOT NULL,
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  PRIMARY KEY (message_id, key_kind, key_value)
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_mail_identity_lookup
  ON mail_message_identity_keys(key_kind, key_value, message_id);

CREATE TABLE mail_message_instances (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  folder_id INTEGER NOT NULL REFERENCES mail_folders(id) ON DELETE CASCADE,
  uid_validity INTEGER NOT NULL,
  remote_uid INTEGER NOT NULL,
  modseq INTEGER,
  flags_bits INTEGER NOT NULL DEFAULT 0,
  keywords_norm TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  last_seen_at_ms INTEGER NOT NULL,
  row_version INTEGER NOT NULL,
  UNIQUE (folder_id, uid_validity, remote_uid)
) STRICT;

CREATE INDEX idx_mail_instances_message
  ON mail_message_instances(message_id, is_active, id);

CREATE TABLE mail_instance_relocations (
  id INTEGER PRIMARY KEY,
  mutation_id INTEGER NOT NULL UNIQUE
    REFERENCES mail_remote_mutations(id) ON DELETE CASCADE,
  instance_id INTEGER REFERENCES mail_message_instances(id) ON DELETE SET NULL,
  message_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  from_folder_id INTEGER REFERENCES mail_folders(id) ON DELETE SET NULL,
  from_uid_validity INTEGER,
  from_remote_uid INTEGER,
  to_folder_id INTEGER NOT NULL REFERENCES mail_folders(id) ON DELETE CASCADE,
  to_uid_validity INTEGER,
  to_remote_uid INTEGER,
  locator_state TEXT NOT NULL CHECK (locator_state IN ('ready','unknown')),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_mail_instance_relocations_message
  ON mail_instance_relocations(message_id, created_at_ms DESC, id DESC);

CREATE TABLE mail_folder_memberships (
  folder_id INTEGER NOT NULL REFERENCES mail_folders(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  representative_instance_id INTEGER NOT NULL
    REFERENCES mail_message_instances(id) ON DELETE CASCADE,
  received_at_ms INTEGER NOT NULL,
  is_seen INTEGER NOT NULL CHECK (is_seen IN (0,1)),
  is_flagged INTEGER NOT NULL CHECK (is_flagged IN (0,1)),
  has_attachments INTEGER NOT NULL CHECK (has_attachments IN (0,1)),
  row_version INTEGER NOT NULL,
  PRIMARY KEY (folder_id, message_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_mail_folder_membership_time
  ON mail_folder_memberships(folder_id, received_at_ms DESC, message_id DESC);
CREATE INDEX idx_mail_folder_membership_unread_time
  ON mail_folder_memberships(
    folder_id, is_seen, received_at_ms DESC, message_id DESC
  );
CREATE INDEX idx_mail_folder_membership_flagged_time
  ON mail_folder_memberships(
    folder_id, is_flagged, received_at_ms DESC, message_id DESC
  );
CREATE INDEX idx_mail_folder_membership_attachment_time
  ON mail_folder_memberships(
    folder_id, has_attachments, received_at_ms DESC, message_id DESC
  );

CREATE TABLE mail_message_references (
  message_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  reference_value TEXT NOT NULL,
  PRIMARY KEY (message_id, ordinal)
) WITHOUT ROWID, STRICT;`,

  // Source: design.md
  `CREATE TABLE mail_message_addresses (
  message_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('from','sender','reply_to','to','cc','bcc')),
  ordinal INTEGER NOT NULL,
  address_norm TEXT NOT NULL,
  address_display TEXT NOT NULL,
  name_display TEXT,
  PRIMARY KEY (message_id, kind, ordinal)
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_mail_addresses_lookup
  ON mail_message_addresses(address_norm, message_id);

CREATE TABLE mail_message_headers (
  message_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  name_norm TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  value_text TEXT NOT NULL,
  PRIMARY KEY (message_id, name_norm, ordinal)
) WITHOUT ROWID, STRICT;

CREATE TABLE mail_blob_objects (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  storage_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  media_type TEXT,
  encryption_kind TEXT NOT NULL DEFAULT 'none',
  ref_count INTEGER NOT NULL CHECK (ref_count >= 0),
  created_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER
) STRICT;

CREATE INDEX idx_mail_blob_hash ON mail_blob_objects(sha256, byte_size);

CREATE TABLE mail_message_content (
  message_id INTEGER PRIMARY KEY REFERENCES mail_messages(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('missing','queued','fetching','ready','failed')),
  text_plain TEXT,
  html_sanitized TEXT,
  raw_mime_blob_id INTEGER REFERENCES mail_blob_objects(id) ON DELETE SET NULL,
  mime_type TEXT,
  charset TEXT,
  content_sha256 TEXT,
  content_version INTEGER NOT NULL DEFAULT 0,
  byte_size INTEGER NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  fetched_at_ms INTEGER,
  retry_at_ms INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  retryable INTEGER NOT NULL DEFAULT 1 CHECK (retryable IN (0,1)),
  error_code TEXT,
  row_version INTEGER NOT NULL,
  CHECK (
    (state = 'ready' AND content_sha256 IS NOT NULL) OR
    (state <> 'ready')
  )
) STRICT;

CREATE TABLE mail_ai_initial_coverage (
  account_id INTEGER PRIMARY KEY REFERENCES mail_accounts(id) ON DELETE CASCADE,
  finalized_at_ms INTEGER NOT NULL,
  row_version INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_mail_messages_initial_ai_summary
  ON mail_messages(account_id, ai_initial_summary_scope,
                   received_at_ms DESC, id DESC)
  WHERE deleted_at_ms IS NULL AND ai_initial_summary_scope = 1;

CREATE TABLE mail_attachments (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  message_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  parent_attachment_id INTEGER REFERENCES mail_attachments(id) ON DELETE CASCADE,
  part_path TEXT NOT NULL,
  filename TEXT,
  filename_norm TEXT,
  media_type TEXT NOT NULL,
  content_id TEXT,
  disposition TEXT,
  byte_size INTEGER NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  is_inline INTEGER NOT NULL DEFAULT 0 CHECK (is_inline IN (0,1)),
  blob_id INTEGER REFERENCES mail_blob_objects(id) ON DELETE SET NULL,
  state TEXT NOT NULL CHECK (state IN ('metadata','queued','fetching','ready','failed')),
  content_sha256 TEXT,
  row_version INTEGER NOT NULL,
  UNIQUE (message_id, part_path)
) STRICT;

CREATE INDEX idx_mail_attachments_message
  ON mail_attachments(message_id, id);`,

  // Source: design.md
  `CREATE TABLE mail_system_categories (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  is_enabled INTEGER NOT NULL CHECK (is_enabled IN (0,1))
) STRICT;

CREATE TABLE mail_message_system_categories (
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES mail_system_categories(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  received_at_ms INTEGER NOT NULL,
  source TEXT NOT NULL,
  score REAL,
  classifier_version TEXT,
  is_seen INTEGER NOT NULL CHECK (is_seen IN (0,1)),
  is_flagged INTEGER NOT NULL CHECK (is_flagged IN (0,1)),
  has_attachments INTEGER NOT NULL CHECK (has_attachments IN (0,1)),
  row_version INTEGER NOT NULL,
  PRIMARY KEY (account_id, category_id, message_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_mail_category_time
  ON mail_message_system_categories(
    account_id, category_id, received_at_ms DESC, message_id DESC
  );
CREATE INDEX idx_mail_category_unread_time
  ON mail_message_system_categories(
    account_id, category_id, is_seen, received_at_ms DESC, message_id DESC
  );
CREATE INDEX idx_mail_category_flagged_time
  ON mail_message_system_categories(
    account_id, category_id, is_flagged, received_at_ms DESC, message_id DESC
  );
CREATE INDEX idx_mail_category_attachment_time
  ON mail_message_system_categories(
    account_id, category_id, has_attachments, received_at_ms DESC, message_id DESC
  );

CREATE TABLE mail_user_tags (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  color TEXT,
  description TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  optimized_prompt TEXT,
  optimized_prompt_version TEXT,
  optimized_from_prompt_hash TEXT,
  optimized_at_ms INTEGER,
  creation_source TEXT NOT NULL DEFAULT 'manual'
    CHECK (creation_source IN ('manual','topic_suggestion','imported','system')),
  source_topic_public_id TEXT
    REFERENCES mail_smart_topics(public_id) ON DELETE SET NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  UNIQUE (account_id, name_norm)
) STRICT;

CREATE TABLE mail_message_user_tags (
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES mail_user_tags(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  received_at_ms INTEGER NOT NULL,
  is_seen INTEGER NOT NULL CHECK (is_seen IN (0,1)),
  is_flagged INTEGER NOT NULL CHECK (is_flagged IN (0,1)),
  has_attachments INTEGER NOT NULL CHECK (has_attachments IN (0,1)),
  source TEXT NOT NULL CHECK (source IN ('ai','user','rule','migration')),
  confidence REAL,
  source_artifact_id INTEGER REFERENCES mail_ai_artifacts(id) ON DELETE SET NULL,
  row_version INTEGER NOT NULL,
  PRIMARY KEY (account_id, tag_id, message_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_mail_tag_time
  ON mail_message_user_tags(
    account_id, tag_id, received_at_ms DESC, message_id DESC
  );
CREATE INDEX idx_mail_tag_unread_time
  ON mail_message_user_tags(
    account_id, tag_id, is_seen, received_at_ms DESC, message_id DESC
  );
CREATE INDEX idx_mail_tag_flagged_time
  ON mail_message_user_tags(
    account_id, tag_id, is_flagged, received_at_ms DESC, message_id DESC
  );
CREATE INDEX idx_mail_tag_attachment_time
  ON mail_message_user_tags(
    account_id, tag_id, has_attachments, received_at_ms DESC, message_id DESC
  );

CREATE TABLE mail_account_counts (
  account_id INTEGER PRIMARY KEY REFERENCES mail_accounts(id) ON DELETE CASCADE,
  total_count INTEGER NOT NULL CHECK (total_count >= 0),
  unread_count INTEGER NOT NULL CHECK (unread_count >= 0),
  flagged_count INTEGER NOT NULL CHECK (flagged_count >= 0),
  row_version INTEGER NOT NULL
) STRICT;

CREATE TABLE mail_folder_counts (
  folder_id INTEGER PRIMARY KEY REFERENCES mail_folders(id) ON DELETE CASCADE,
  total_count INTEGER NOT NULL CHECK (total_count >= 0),
  unread_count INTEGER NOT NULL CHECK (unread_count >= 0),
  row_version INTEGER NOT NULL
) STRICT;

CREATE TABLE mail_category_counts (
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES mail_system_categories(id) ON DELETE CASCADE,
  total_count INTEGER NOT NULL CHECK (total_count >= 0),
  unread_count INTEGER NOT NULL CHECK (unread_count >= 0),
  row_version INTEGER NOT NULL,
  PRIMARY KEY (account_id, category_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE mail_tag_counts (
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES mail_user_tags(id) ON DELETE CASCADE,
  total_count INTEGER NOT NULL CHECK (total_count >= 0),
  unread_count INTEGER NOT NULL CHECK (unread_count >= 0),
  row_version INTEGER NOT NULL,
  PRIMARY KEY (account_id, tag_id)
) WITHOUT ROWID, STRICT;`,

  // Source: design.md
  `CREATE VIRTUAL TABLE mail_search_fts USING fts5(
  account_terms,
  subject_terms,
  sender_terms,
  recipient_terms,
  body_terms,
  attachment_terms,
  summary_terms,
  content='',
  contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3 4'
);

CREATE TABLE mail_search_index_state (
  message_id INTEGER PRIMARY KEY REFERENCES mail_messages(id) ON DELETE CASCADE,
  indexed_content_version INTEGER NOT NULL,
  indexed_summary_version INTEGER NOT NULL DEFAULT 0,
  indexed_at_ms INTEGER NOT NULL,
  row_version INTEGER NOT NULL
) STRICT;`,

  // Source: design.md
  `CREATE TABLE mail_ai_artifacts (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('message','thread')),
  message_id INTEGER REFERENCES mail_messages(id) ON DELETE CASCADE,
  thread_id INTEGER REFERENCES mail_threads(id) ON DELETE CASCADE,
  artifact_kind TEXT NOT NULL,
  source_content_sha256 TEXT,
  source_version INTEGER NOT NULL,
  processor_version TEXT NOT NULL,
  prompt_version TEXT,
  model_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued','running','ready','failed','stale')),
  text_value TEXT,
  json_value TEXT,
  error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  row_version INTEGER NOT NULL,
  CHECK (
    (scope_kind = 'message' AND message_id IS NOT NULL AND thread_id IS NULL) OR
    (scope_kind = 'thread' AND thread_id IS NOT NULL AND message_id IS NULL)
  )
) STRICT;

CREATE INDEX idx_mail_ai_artifact_history
  ON mail_ai_artifacts(
    scope_kind, message_id, thread_id, artifact_kind, created_at_ms DESC, id DESC
  );

CREATE TABLE mail_message_ai_current (
  message_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  artifact_kind TEXT NOT NULL,
  artifact_id INTEGER NOT NULL REFERENCES mail_ai_artifacts(id) ON DELETE CASCADE,
  row_version INTEGER NOT NULL,
  PRIMARY KEY (message_id, artifact_kind)
) WITHOUT ROWID, STRICT;`,

  // Source: design.md
  `CREATE TABLE mail_jobs (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  job_kind TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_public_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN
    ('pending','leased','succeeded','failed','cancelled','terminal')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
  available_at_ms INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at_ms INTEGER,
  input_version INTEGER NOT NULL,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  row_version INTEGER NOT NULL,
  UNIQUE (job_kind, dedupe_key, input_version)
) STRICT;

CREATE INDEX idx_mail_jobs_claim_kind
  ON mail_jobs(job_kind, priority ASC, available_at_ms ASC, id)
  WHERE state = 'pending';

CREATE INDEX idx_mail_jobs_claim_kind_lifo
  ON mail_jobs(job_kind, priority ASC, id DESC)
  WHERE state = 'pending';

CREATE INDEX idx_mail_jobs_subject_version
  ON mail_jobs(subject_public_id, job_kind, input_version);

CREATE TABLE mail_remote_mutations (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES mail_messages(id) ON DELETE SET NULL,
  instance_id INTEGER REFERENCES mail_message_instances(id) ON DELETE SET NULL,
  mutation_kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('pending','leased','applied','conflict','failed','terminal','cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at_ms INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at_ms INTEGER,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  row_version INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_mail_remote_mutations_claim
  ON mail_remote_mutations(state, available_at_ms, id)
  WHERE state = 'pending';

CREATE TABLE mail_drafts (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  reply_to_message_id INTEGER REFERENCES mail_messages(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  body_text TEXT,
  body_html TEXT,
  state TEXT NOT NULL CHECK (state IN ('editing','queued','sent','discarded')),
  scheduled_at_ms INTEGER,
  client_revision INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  row_version INTEGER NOT NULL
) STRICT;

CREATE TABLE mail_draft_recipients (
  draft_id INTEGER NOT NULL REFERENCES mail_drafts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('to','cc','bcc')),
  ordinal INTEGER NOT NULL,
  address_norm TEXT NOT NULL,
  address_display TEXT NOT NULL,
  name_display TEXT,
  PRIMARY KEY (draft_id, kind, ordinal)
) WITHOUT ROWID, STRICT;

CREATE TABLE mail_draft_attachments (
  draft_id INTEGER NOT NULL REFERENCES mail_drafts(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  blob_id INTEGER NOT NULL REFERENCES mail_blob_objects(id),
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  PRIMARY KEY (draft_id, ordinal)
) WITHOUT ROWID, STRICT;

CREATE TABLE mail_outbox_items (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  draft_id INTEGER REFERENCES mail_drafts(id) ON DELETE SET NULL,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  frozen_subject TEXT NOT NULL,
  frozen_body_text TEXT,
  frozen_body_html TEXT,
  state TEXT NOT NULL CHECK (state IN
    ('pending','leased','sending','sent','failed','terminal','cancelled')),
  scheduled_at_ms INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  available_at_ms INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at_ms INTEGER,
  smtp_recovery_id TEXT,
  message_id_header TEXT NOT NULL,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  row_version INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_mail_outbox_claim
  ON mail_outbox_items(state, available_at_ms, id)
  WHERE state = 'pending';

CREATE TABLE mail_outbox_recipients (
  outbox_id INTEGER NOT NULL REFERENCES mail_outbox_items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('to','cc','bcc')),
  ordinal INTEGER NOT NULL,
  address_norm TEXT NOT NULL,
  address_display TEXT NOT NULL,
  name_display TEXT,
  PRIMARY KEY (outbox_id, kind, ordinal)
) WITHOUT ROWID, STRICT;

CREATE TABLE mail_outbox_attachments (
  outbox_id INTEGER NOT NULL REFERENCES mail_outbox_items(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  blob_id INTEGER NOT NULL REFERENCES mail_blob_objects(id),
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  PRIMARY KEY (outbox_id, ordinal)
) WITHOUT ROWID, STRICT;

`,

  // Source: intelligence-design.md
  `CREATE TABLE mail_tag_feedback_rules (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES mail_user_tags(id) ON DELETE CASCADE,
  sender_pattern_norm TEXT NOT NULL DEFAULT '',
  subject_prefix_norm TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL CHECK (action IN ('reject','promote')),
  reason TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  row_version INTEGER NOT NULL,
  UNIQUE (
    account_id, tag_id, sender_pattern_norm, subject_prefix_norm, action
  )
) STRICT;

CREATE INDEX idx_mail_tag_feedback_match
  ON mail_tag_feedback_rules(
    account_id, tag_id, sender_pattern_norm, subject_prefix_norm, action
  );

CREATE TABLE mail_ai_feedback_events (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES mail_messages(id) ON DELETE SET NULL,
  thread_id INTEGER REFERENCES mail_threads(id) ON DELETE SET NULL,
  artifact_id INTEGER REFERENCES mail_ai_artifacts(id) ON DELETE SET NULL,
  feature TEXT NOT NULL,
  event_type TEXT NOT NULL,
  target_kind TEXT,
  target_public_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_mail_ai_feedback_feature_time
  ON mail_ai_feedback_events(account_id, feature, created_at_ms DESC, id DESC);
CREATE INDEX idx_mail_ai_feedback_message_time
  ON mail_ai_feedback_events(message_id, created_at_ms DESC, id DESC)
  WHERE message_id IS NOT NULL;

CREATE TABLE mail_learning_summaries (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  feature TEXT NOT NULL,
  signals_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  row_version INTEGER NOT NULL,
  UNIQUE (account_id, feature)
) STRICT;

CREATE INDEX idx_mail_learning_summaries_account_feature
  ON mail_learning_summaries(account_id, feature);

CREATE TABLE mail_todos (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES mail_messages(id) ON DELETE SET NULL,
  source_artifact_id INTEGER REFERENCES mail_ai_artifacts(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  description TEXT,
  due_at_ms INTEGER,
  start_at_ms INTEGER,
  end_at_ms INTEGER,
  timezone TEXT,
  priority TEXT NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low','medium','high')),
  status TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('ai','user','agent','mcp','automation','migration')),
  completed_at_ms INTEGER,
  agent_status TEXT,
  agent_status_locked INTEGER NOT NULL DEFAULT 0
    CHECK (agent_status_locked IN (0,1)),
  agent_status_updated_at_ms INTEGER,
  extraction_reason TEXT,
  extraction_confidence REAL,
  extraction_evidence_json TEXT,
  task_agent_reason TEXT,
  task_agent_confidence REAL,
  task_agent_evidence_json TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  row_version INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_mail_todos_account_status_time
  ON mail_todos(account_id, status, due_at_ms, id)
  WHERE deleted_at_ms IS NULL;
CREATE INDEX idx_mail_todos_message
  ON mail_todos(message_id, id) WHERE message_id IS NOT NULL;

CREATE TABLE mail_todo_suppressions (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  normalized_title TEXT NOT NULL,
  due_key TEXT NOT NULL DEFAULT '',
  source_content_sha256 TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (message_id, normalized_title, due_key)
) STRICT;

CREATE INDEX idx_mail_todo_suppression_lookup
  ON mail_todo_suppressions(
    account_id, message_id, normalized_title, due_key
  );

CREATE TABLE mail_system_category_overrides (
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES mail_system_categories(id) ON DELETE CASCADE,
  matched INTEGER NOT NULL CHECK (matched IN (0,1)),
  reason TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  row_version INTEGER NOT NULL,
  PRIMARY KEY (account_id, message_id, category_id)
) WITHOUT ROWID, STRICT;`,

  // Source: intelligence-design.md
  `CREATE TABLE mail_smart_tag_actions (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES mail_user_tags(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  feedback_type TEXT NOT NULL,
  reason TEXT,
  processed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_mail_smart_tag_actions_learning
  ON mail_smart_tag_actions(
    account_id, tag_id, processed_at_ms, created_at_ms, id
  );

CREATE TABLE mail_smart_tag_prompt_revisions (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES mail_user_tags(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  old_prompt TEXT NOT NULL,
  new_prompt TEXT NOT NULL,
  old_prompt_hash TEXT NOT NULL,
  new_prompt_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  source_learning_run_id INTEGER
    REFERENCES mail_smart_tag_learning_runs(id) ON DELETE SET NULL,
  action_count INTEGER NOT NULL CHECK (action_count >= 0),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (tag_id, revision)
) STRICT;

CREATE TABLE mail_smart_tag_learning_runs (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES mail_user_tags(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at_ms INTEGER,
  source_prompt_hash TEXT NOT NULL,
  active_prompt_hash TEXT NOT NULL,
  model_generation INTEGER NOT NULL,
  model_id TEXT NOT NULL,
  candidate_prompt TEXT,
  candidate_summary_json TEXT,
  sample_count INTEGER NOT NULL DEFAULT 0,
  positive_count INTEGER NOT NULL DEFAULT 0,
  negative_count INTEGER NOT NULL DEFAULT 0,
  optimization_count INTEGER NOT NULL DEFAULT 0,
  validation_count INTEGER NOT NULL DEFAULT 0,
  current_correct INTEGER NOT NULL DEFAULT 0,
  candidate_correct INTEGER NOT NULL DEFAULT 0,
  corrected_count INTEGER NOT NULL DEFAULT 0,
  regression_count INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  created_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  completed_at_ms INTEGER,
  activated_at_ms INTEGER
) STRICT;

CREATE UNIQUE INDEX idx_mail_smart_tag_learning_active
  ON mail_smart_tag_learning_runs(account_id, tag_id)
  WHERE state IN ('generating','evaluating');

CREATE TABLE mail_smart_tag_learning_samples (
  run_id INTEGER NOT NULL
    REFERENCES mail_smart_tag_learning_runs(id) ON DELETE CASCADE,
  action_id INTEGER NOT NULL
    REFERENCES mail_smart_tag_actions(id) ON DELETE RESTRICT,
  message_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE RESTRICT,
  split TEXT NOT NULL CHECK (split IN ('train','validation','confirmation')),
  expected_action TEXT NOT NULL,
  is_new_feedback INTEGER NOT NULL DEFAULT 0 CHECK (is_new_feedback IN (0,1)),
  current_matched INTEGER CHECK (current_matched IN (0,1)),
  candidate_matched INTEGER CHECK (candidate_matched IN (0,1)),
  confirmation_matched INTEGER CHECK (confirmation_matched IN (0,1)),
  current_confidence REAL,
  candidate_confidence REAL,
  confirmation_confidence REAL,
  error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, message_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE mail_smart_tag_backfill_runs (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  target_tag_id INTEGER REFERENCES mail_user_tags(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  scope TEXT NOT NULL,
  state TEXT NOT NULL,
  target_fingerprint TEXT,
  prompt_version TEXT,
  cursor_received_at_ms INTEGER,
  cursor_message_id INTEGER,
  scanned_count INTEGER NOT NULL DEFAULT 0,
  queued_count INTEGER NOT NULL DEFAULT 0,
  recent_count INTEGER NOT NULL DEFAULT 0,
  historical_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  retained_count INTEGER NOT NULL DEFAULT 0,
  removed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER
) STRICT;

CREATE TABLE mail_smart_tag_retag_items (
  run_id INTEGER NOT NULL
    REFERENCES mail_smart_tag_backfill_runs(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  original_source TEXT NOT NULL,
  state TEXT NOT NULL,
  matched INTEGER CHECK (matched IN (0,1)),
  confidence REAL,
  error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, message_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_mail_smart_tag_retag_pending
  ON mail_smart_tag_retag_items(run_id, state, message_id);

CREATE TABLE mail_smart_topics (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  normalized_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL,
  mail_count INTEGER NOT NULL DEFAULT 0,
  thread_count INTEGER NOT NULL DEFAULT 0,
  sender_count INTEGER NOT NULL DEFAULT 0,
  positive_count INTEGER NOT NULL DEFAULT 0,
  negative_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  last_suggested_at_ms INTEGER,
  deferred_at_ms INTEGER,
  suppressed_at_ms INTEGER,
  user_tag_id INTEGER REFERENCES mail_user_tags(id) ON DELETE SET NULL,
  application_message_public_id TEXT
    REFERENCES application_messages(id) ON DELETE SET NULL,
  promotion_description TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (account_id, normalized_key)
) STRICT;

CREATE TABLE mail_smart_topic_evidence (
  topic_id INTEGER NOT NULL REFERENCES mail_smart_topics(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  thread_id INTEGER REFERENCES mail_threads(id) ON DELETE SET NULL,
  sender_key TEXT,
  confidence REAL NOT NULL,
  polarity TEXT NOT NULL CHECK (polarity IN ('positive','negative')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (topic_id, message_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_mail_smart_topic_evidence_message
  ON mail_smart_topic_evidence(message_id, topic_id);`,

  // Source: intelligence-design.md
  `CREATE TABLE mail_digest_settings (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id INTEGER REFERENCES mail_accounts(id) ON DELETE CASCADE,
  manual_enabled INTEGER NOT NULL CHECK (manual_enabled IN (0,1)),
  manual_window_hours INTEGER NOT NULL,
  inactivity_enabled INTEGER NOT NULL CHECK (inactivity_enabled IN (0,1)),
  inactivity_hours INTEGER NOT NULL,
  daily_enabled INTEGER NOT NULL CHECK (daily_enabled IN (0,1)),
  daily_local_time TEXT NOT NULL,
  daily_window_mode TEXT NOT NULL,
  last_opened_at_ms INTEGER,
  last_daily_digest_key TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  row_version INTEGER NOT NULL
) STRICT;

CREATE TABLE mail_digests (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL
    CHECK (scope_kind IN ('account','folder','thread','category','tag')),
  scope_key TEXT NOT NULL,
  folder_id INTEGER REFERENCES mail_folders(id) ON DELETE SET NULL,
  thread_id INTEGER REFERENCES mail_threads(id) ON DELETE SET NULL,
  category_id INTEGER REFERENCES mail_system_categories(id) ON DELETE SET NULL,
  tag_id INTEGER REFERENCES mail_user_tags(id) ON DELETE SET NULL,
  digest_kind TEXT NOT NULL,
  window_start_ms INTEGER NOT NULL,
  window_end_ms INTEGER NOT NULL,
  source_commit_version INTEGER NOT NULL
    REFERENCES db_commits(version) ON DELETE RESTRICT,
  source_content_hash TEXT NOT NULL,
  item_count INTEGER NOT NULL CHECK (item_count >= 0),
  result_json TEXT NOT NULL,
  model_id TEXT,
  processor_version TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (
    account_id, scope_kind, scope_key, digest_kind, window_start_ms, window_end_ms
  )
) STRICT;

CREATE INDEX idx_mail_digests_account_time
  ON mail_digests(account_id, created_at_ms DESC, id DESC);

CREATE TABLE mail_digest_members (
  digest_id INTEGER NOT NULL REFERENCES mail_digests(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  message_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE RESTRICT,
  source_content_version INTEGER NOT NULL,
  source_content_sha256 TEXT,
  PRIMARY KEY (digest_id, ordinal),
  UNIQUE (digest_id, message_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE mail_draft_versions (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  draft_id INTEGER REFERENCES mail_drafts(id) ON DELETE CASCADE,
  source_message_id INTEGER REFERENCES mail_messages(id) ON DELETE SET NULL,
  version INTEGER NOT NULL,
  state TEXT NOT NULL,
  draft_markdown TEXT NOT NULL,
  language TEXT NOT NULL,
  style_public_id TEXT,
  model_id TEXT,
  source_content_sha256 TEXT,
  content_sha256 TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (draft_id IS NOT NULL OR source_message_id IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX idx_mail_draft_versions_draft_version
  ON mail_draft_versions(draft_id, version) WHERE draft_id IS NOT NULL;
CREATE UNIQUE INDEX idx_mail_draft_versions_source_version
  ON mail_draft_versions(source_message_id, version) WHERE draft_id IS NULL;

CREATE TABLE mail_translations (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  target_language TEXT NOT NULL,
  processor_version TEXT NOT NULL,
  source_content_sha256 TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  paragraphs_json TEXT,
  model_id TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (
    message_id, target_language, processor_version, source_content_sha256
  )
) STRICT;

CREATE INDEX idx_mail_translations_message
  ON mail_translations(message_id, target_language, created_at_ms DESC);

CREATE TABLE mail_semantic_chunks (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  chunk_key TEXT NOT NULL,
  chunk_ordinal INTEGER NOT NULL,
  source_content_sha256 TEXT NOT NULL,
  source_content_version INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  lexical_terms TEXT NOT NULL DEFAULT '',
  embedding_model TEXT NOT NULL,
  embedding_version TEXT NOT NULL,
  embedding_dimensions INTEGER NOT NULL CHECK (embedding_dimensions > 0),
  embedding_f32 BLOB NOT NULL,
  embedding_sha256 TEXT NOT NULL,
  indexed_at_ms INTEGER NOT NULL,
  row_version INTEGER NOT NULL,
  UNIQUE (message_id, chunk_key, embedding_model, embedding_version)
) STRICT;

CREATE INDEX idx_mail_semantic_chunks_message
  ON mail_semantic_chunks(message_id, chunk_ordinal, id);
CREATE INDEX idx_mail_semantic_chunks_model
  ON mail_semantic_chunks(
    account_id, embedding_model, embedding_version, id
  );

CREATE TABLE mail_semantic_index_state (
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  embedding_model TEXT NOT NULL,
  embedding_version TEXT NOT NULL,
  sidecar_generation INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0),
  content_sha256 TEXT NOT NULL,
  built_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('building','ready','stale','failed')),
  PRIMARY KEY (account_id, embedding_model, embedding_version)
) WITHOUT ROWID, STRICT;

CREATE TABLE mail_attachment_semantic_attributes (
  attachment_id INTEGER NOT NULL REFERENCES mail_attachments(id) ON DELETE CASCADE,
  field_path TEXT NOT NULL,
  value_type TEXT NOT NULL,
  value_text TEXT,
  value_json TEXT,
  state TEXT NOT NULL,
  source TEXT,
  confidence REAL,
  extractor_version TEXT NOT NULL,
  source_content_sha256 TEXT,
  reason_code TEXT,
  extracted_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (attachment_id, field_path)
) WITHOUT ROWID, STRICT;`,

  // Source: intelligence-design.md
  `CREATE TABLE automation_mail_references (
  id INTEGER PRIMARY KEY,
  rule_public_id TEXT NOT NULL
    REFERENCES automation_rules(id) ON DELETE CASCADE,
  reference_kind TEXT NOT NULL
    CHECK (reference_kind IN ('message','thread','folder','category','tag')),
  message_id INTEGER REFERENCES mail_messages(id) ON DELETE CASCADE,
  thread_id INTEGER REFERENCES mail_threads(id) ON DELETE CASCADE,
  folder_id INTEGER REFERENCES mail_folders(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES mail_system_categories(id) ON DELETE CASCADE,
  tag_id INTEGER REFERENCES mail_user_tags(id) ON DELETE CASCADE,
  created_at_ms INTEGER NOT NULL,
  CHECK (
    (message_id IS NOT NULL) + (thread_id IS NOT NULL) +
    (folder_id IS NOT NULL) + (category_id IS NOT NULL) +
    (tag_id IS NOT NULL) = 1
  )
) STRICT;

CREATE UNIQUE INDEX idx_automation_mail_reference_identity
  ON automation_mail_references(
    rule_public_id, reference_kind,
    COALESCE(message_id, -1), COALESCE(thread_id, -1),
    COALESCE(folder_id, -1), COALESCE(category_id, -1), COALESCE(tag_id, -1)
  );

CREATE TABLE automation_run_mail_items (
  run_public_id TEXT NOT NULL
    REFERENCES automation_rule_runs(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE RESTRICT,
  reference_kind TEXT NOT NULL
    CHECK (reference_kind IN ('message','attachment','thread')),
  message_id INTEGER REFERENCES mail_messages(id) ON DELETE RESTRICT,
  attachment_id INTEGER REFERENCES mail_attachments(id) ON DELETE RESTRICT,
  thread_id INTEGER REFERENCES mail_threads(id) ON DELETE RESTRICT,
  parent_message_id INTEGER REFERENCES mail_messages(id) ON DELETE RESTRICT,
  occurred_at_ms INTEGER NOT NULL,
  selection_reason TEXT NOT NULL,
  source_content_sha256 TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  CHECK (
    (message_id IS NOT NULL) + (attachment_id IS NOT NULL) +
    (thread_id IS NOT NULL) = 1
  ),
  PRIMARY KEY (run_public_id, ordinal)
) WITHOUT ROWID, STRICT;

CREATE TABLE automation_deferred_mail_targets (
  execution_public_id TEXT PRIMARY KEY
    REFERENCES automation_deferred_executions(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE RESTRICT,
  source_content_version INTEGER NOT NULL,
  source_content_sha256 TEXT
) WITHOUT ROWID, STRICT;

CREATE TABLE agent_pending_action_targets (
  action_public_id TEXT PRIMARY KEY
    REFERENCES agent_pending_actions(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL
    CHECK (target_kind IN
      ('none','message','thread','draft','automation_rule','artifact')),
  message_id INTEGER REFERENCES mail_messages(id) ON DELETE SET NULL,
  thread_id INTEGER REFERENCES mail_threads(id) ON DELETE SET NULL,
  draft_id INTEGER REFERENCES mail_drafts(id) ON DELETE SET NULL,
  target_public_id TEXT,
  source_row_version INTEGER,
  CHECK (
    (target_kind = 'none' AND message_id IS NULL AND thread_id IS NULL
      AND draft_id IS NULL AND target_public_id IS NULL) OR
    (target_kind = 'message' AND message_id IS NOT NULL) OR
    (target_kind = 'thread' AND thread_id IS NOT NULL) OR
    (target_kind = 'draft' AND draft_id IS NOT NULL) OR
    (target_kind IN ('automation_rule','artifact') AND target_public_id IS NOT NULL)
  )
) WITHOUT ROWID, STRICT;

CREATE TABLE message_artifact_blob_resources (
  artifact_public_id TEXT NOT NULL,
  artifact_version INTEGER NOT NULL,
  resource_name TEXT NOT NULL,
  blob_id INTEGER NOT NULL REFERENCES mail_blob_objects(id) ON DELETE RESTRICT,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT NOT NULL,
  PRIMARY KEY (artifact_public_id, artifact_version, resource_name),
  FOREIGN KEY (artifact_public_id, artifact_version)
    REFERENCES message_artifacts(id, version) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;`,

] as const;

export const MAIL_DATABASE_SCHEMA_SQL =
  MAIL_DATABASE_SCHEMA_BLOCKS.join("\n\n");
