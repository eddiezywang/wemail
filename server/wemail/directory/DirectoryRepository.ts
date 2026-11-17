import type {
  DirectoryContactQueryOptions,
  DirectoryContactSummary,
  DirectoryDepartment,
  DirectorySyncStatus,
} from "../../../shared/wemail/directory.js";
import { randomUUID } from "node:crypto";
import { cleanupDirectorySnapshots } from "./DirectorySnapshotMaintenance.js";
import type { MailDatabase } from "../database/Database.js";
import { DirectoryWriteParamsSchema, type DirectoryWriteParams, type DirectoryContactInput } from "../../../shared/wemail/directoryDatabase.js";
import { DirectoryReadParamsSchema, type DirectoryReadParams, type DirectoryReadResult } from "../../../shared/wemail/directoryDatabase.js";
export type { DirectoryContactInput } from "../../../shared/wemail/directoryDatabase.js";
import {
  resolveDirectoryPinyin,
  type DirectoryPinyinPort,
} from "./DirectoryRemoteClient.js";

interface DepartmentInput extends Omit<DirectoryDepartment, "accountId" | "syncedAt"> {}

export class DirectoryRepository {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
    /**
     * Pinyin search-index port. Defaults to the build-time registration
     * (`EditionModules.directory?.pinyin`), which also reaches the DB
     * reader/writer worker lanes; the open edition resolves to a no-op port.
     * Explicit injection keeps tests and ComposeAppOverrides deterministic.
     */
    private readonly pinyin: DirectoryPinyinPort = resolveDirectoryPinyin(),
  ) {}

  write(input: DirectoryWriteParams): number {
    return this.applyWrite(input);
  }

  private applyWrite(input: DirectoryWriteParams): number {
    const params = DirectoryWriteParamsSchema.parse(input);
    switch (params.operation) {
      case "cleanupSnapshots": return this.db.transaction(() => cleanupDirectorySnapshots(this.db, Date.parse(this.now()))).immediate();
      case "replaceSnapshot": this.replaceSnapshot(params.accountId, params.departments, params.contacts); break;
      case "upsertContacts": this.upsertContacts(params.accountId, params.contacts); break;
      case "setStatus": this.setStatus(params.status); break;
      case "indexPinyinBatch": return this.ensurePinyinIndex(params.accountId, 100);
      case "beginSnapshot":
        this.db.transaction(() => {
          if (!this.db.prepare("SELECT 1 FROM mail_accounts WHERE public_id = ?").get(params.accountId)) {
            throw new Error("directory-account-not-found");
          }
          this.ensureLegacyHead(params.accountId);
          this.db.prepare("UPDATE directory_snapshots SET state = 'retired' WHERE account_id = ? AND state = 'staging'").run(params.accountId);
          this.db.prepare(`INSERT INTO directory_snapshots
            (account_id, id, state, department_count, contact_count, expires_at_ms)
            VALUES (?, ?, 'staging', ?, ?, ?)`).run(params.accountId, params.snapshotId,
              params.departmentCount, params.contactCount, Date.parse(this.now()) + 300_000);
        }).immediate();
        break;
      case "abortSnapshot":
        this.db.prepare("UPDATE directory_snapshots SET state = 'retired' WHERE account_id = ? AND id = ? AND state = 'staging'").run(params.accountId, params.snapshotId);
        break;
      case "appendSnapshot": {
        const contacts = params.contacts.map((item) => withPinyinIndex(item, this.pinyin));
        this.db.transaction(() => {
          const snapshot = this.stagedSnapshot(params.accountId, params.snapshotId);
          if (Number(snapshot.sequence) !== params.sequence ||
              Number(snapshot.received_departments) + params.departments.length > Number(snapshot.department_count) ||
              Number(snapshot.received_contacts) + contacts.length > Number(snapshot.contact_count)) {
            throw new Error("directory-snapshot-invalid-chunk");
          }
          this.insertSnapshotRows(params.accountId, params.snapshotId, params.departments, contacts);
          this.db.prepare(`UPDATE directory_snapshots SET received_departments = received_departments + ?,
            received_contacts = received_contacts + ?, sequence = sequence + 1, expires_at_ms = ?
            WHERE account_id = ? AND id = ?`).run(params.departments.length, contacts.length,
              Date.parse(this.now()) + 300_000, params.accountId, params.snapshotId);
        }).immediate();
        break;
      }
      case "commitSnapshot":
        this.db.transaction(() => {
          if (this.activeSnapshotId(params.accountId) === params.snapshotId) return;
          const snapshot = this.stagedSnapshot(params.accountId, params.snapshotId);
          if (Number(snapshot.received_departments) !== Number(snapshot.department_count) ||
              Number(snapshot.received_contacts) !== Number(snapshot.contact_count)) throw new Error("directory-snapshot-incomplete");
          this.db.prepare("UPDATE directory_snapshots SET state = 'retired' WHERE account_id = ? AND state = 'active'").run(params.accountId);
          this.db.prepare("UPDATE directory_snapshots SET state = 'active', expires_at_ms = NULL WHERE account_id = ? AND id = ?").run(params.accountId, params.snapshotId);
          this.db.prepare(`INSERT INTO directory_snapshot_heads(account_id, snapshot_id) VALUES (?, ?)
            ON CONFLICT(account_id) DO UPDATE SET snapshot_id = excluded.snapshot_id`).run(params.accountId, params.snapshotId);
        }).immediate();
        break;
    }
    return 0;
  }

  read(input: DirectoryReadParams): DirectoryReadResult {
    const params = DirectoryReadParamsSchema.parse(input);
    switch (params.operation) {
      case "getStatus": return this.getStatus(params.accountId);
      case "listDepartments": return this.listDepartments(params.accountId, params.parentId);
      case "getContact": return params.idOrEmail.includes("@")
        ? this.findByEmail(params.accountId, params.idOrEmail)
        : this.findById(params.accountId, params.idOrEmail);
      case "searchContacts": return this.db.transaction(() => ({
        contacts: this.searchContacts(params.accountId, params.query, params.options),
        total: this.countContacts(params.accountId, params.query, params.options),
      }))();
    }
  }

  hasSnapshot(accountId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS found FROM directory_active_contacts WHERE account_id = ? LIMIT 1")
      .get(accountId) as { found: number } | undefined;
    return !!row;
  }

  replaceSnapshot(accountId: string, departments: DepartmentInput[], contacts: DirectoryContactInput[]): void {
    const snapshotId = randomUUID();
    this.applyWrite({ operation: "beginSnapshot", accountId, snapshotId,
      departmentCount: departments.length, contactCount: contacts.length });
    try {
      let sequence = 0;
      for (let offset = 0; offset < Math.max(departments.length, contacts.length); offset += 100) {
        this.applyWrite({ operation: "appendSnapshot", accountId, snapshotId, sequence: sequence++,
          departments: departments.slice(offset, offset + 100), contacts: contacts.slice(offset, offset + 100) });
      }
      this.applyWrite({ operation: "commitSnapshot", accountId, snapshotId });
    } catch (error) {
      this.applyWrite({ operation: "abortSnapshot", accountId, snapshotId });
      throw error;
    }
  }

  private activeSnapshotId(accountId: string): string {
    return (this.db.prepare("SELECT snapshot_id FROM directory_snapshot_heads WHERE account_id = ?").get(accountId) as { snapshot_id: string } | undefined)?.snapshot_id ?? "legacy";
  }

  private ensureLegacyHead(accountId: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO directory_snapshots(account_id, id, state)
      SELECT public_id, 'legacy', 'active' FROM mail_accounts WHERE public_id = ?
        AND NOT EXISTS (SELECT 1 FROM directory_snapshot_heads WHERE account_id = ?)`)
      .run(accountId, accountId);
    this.db.prepare(`INSERT OR IGNORE INTO directory_snapshot_heads(account_id, snapshot_id)
      SELECT account_id, id FROM directory_snapshots WHERE account_id = ? AND id = 'legacy'`)
      .run(accountId);
  }

  private stagedSnapshot(accountId: string, snapshotId: string): Record<string, unknown> {
    const row = this.db.prepare("SELECT * FROM directory_snapshots WHERE account_id = ? AND id = ? AND state = 'staging'").get(accountId, snapshotId) as Record<string, unknown> | undefined;
    if (!row || Number(row.expires_at_ms) <= Date.parse(this.now())) throw new Error("directory-snapshot-expired-or-replaced");
    return row;
  }

  private insertSnapshotRows(accountId: string, snapshotId: string, departments: DepartmentInput[], contacts: DirectoryContactInput[]): void {
    const syncedAt = this.now();
    const insertDepartment = this.db.prepare(`INSERT INTO directory_departments
      (account_id, snapshot_id, id, parent_id, name, path, child_count, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertContact = this.db.prepare(`INSERT INTO directory_contacts
      (account_id, snapshot_id, id, name, email, aliases_json, department_id, department_path, title,
       full_pinyin, pinyin_initials, pinyin_index_version, mobile, company_phone, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertFts = this.db.prepare("INSERT INTO directory_contacts_fts(rowid, account_id, contact_id, search_text) VALUES (?, ?, ?, ?)");
    for (const item of departments) insertDepartment.run(accountId, snapshotId, item.id, item.parentId ?? null,
      item.name, item.path, item.childCount, syncedAt);
    for (const item of contacts) {
      const inserted = insertContact.run(accountId, snapshotId, item.id, item.name, item.email, JSON.stringify(item.aliases),
        item.departmentId ?? null, item.departmentPath ?? null, item.title ?? null, item.fullPinyin ?? "",
        item.pinyinInitials ?? "", item.pinyinIndexVersion ?? this.pinyin.version,
        item.mobile ?? null, item.companyPhone ?? null, syncedAt);
      insertFts.run(inserted.lastInsertRowid, accountId, item.id, contactSearchText(item));
    }
  }

  upsertContacts(accountId: string, contacts: DirectoryContactInput[]): void {
    if (contacts.length === 0) return;
    const syncedAt = this.now();
    const findExisting = this.db.prepare(`
      SELECT * FROM directory_active_contacts
      WHERE account_id = ? AND email = ? COLLATE NOCASE
      LIMIT 1
    `);
    const upsertContact = this.db.prepare(`
      INSERT INTO directory_contacts (
        account_id, snapshot_id, id, name, email, aliases_json, department_id,
        department_path, title, full_pinyin, pinyin_initials,
        pinyin_index_version, mobile, company_phone, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, snapshot_id, id) DO UPDATE SET
        name = excluded.name,
        email = excluded.email,
        aliases_json = excluded.aliases_json,
        department_id = excluded.department_id,
        department_path = excluded.department_path,
        title = excluded.title,
        full_pinyin = excluded.full_pinyin,
        pinyin_initials = excluded.pinyin_initials,
        pinyin_index_version = excluded.pinyin_index_version,
        mobile = excluded.mobile,
        company_phone = excluded.company_phone,
        synced_at = excluded.synced_at
    `);
    const deleteFts = this.db.prepare(
      "DELETE FROM directory_contacts_fts WHERE rowid = (SELECT storage_id FROM directory_active_contacts WHERE account_id = ? AND id = ?)",
    );
    const insertFts = this.db.prepare(`
      INSERT INTO directory_contacts_fts (rowid, account_id, contact_id, search_text)
      SELECT storage_id, account_id, id, ? FROM directory_active_contacts WHERE account_id = ? AND id = ?
    `);

    this.db.transaction(() => {
      this.ensureLegacyHead(accountId);
      for (const rawItem of contacts) {
        const item = withPinyinIndex(rawItem, this.pinyin);
        const existing = findExisting.get(accountId, item.email) as Record<string, unknown> | undefined;
        const aliases = Array.from(new Set([
          ...readAliases(existing?.aliases_json),
          ...item.aliases,
        ].map((value) => value.trim()).filter(Boolean)));
        const effective: DirectoryContactInput = {
          id: existing ? String(existing.id) : item.id,
          name: item.name || (existing ? String(existing.name) : item.email),
          email: item.email,
          aliases,
          departmentId: item.departmentId ?? optionalString(existing?.department_id),
          departmentPath: item.departmentPath ?? optionalString(existing?.department_path),
          title: item.title ?? optionalString(existing?.title),
          fullPinyin: item.fullPinyin ?? optionalString(existing?.full_pinyin),
          pinyinInitials: item.pinyinInitials ?? optionalString(existing?.pinyin_initials),
          pinyinIndexVersion: item.pinyinIndexVersion ?? optionalNumber(existing?.pinyin_index_version),
          mobile: item.mobile ?? optionalString(existing?.mobile),
          companyPhone: item.companyPhone ?? optionalString(existing?.company_phone),
          searchTerms: item.searchTerms,
        };
        upsertContact.run(
          accountId,
          this.activeSnapshotId(accountId),
          effective.id,
          effective.name,
          effective.email,
          JSON.stringify(effective.aliases),
          effective.departmentId ?? null,
          effective.departmentPath ?? null,
          effective.title ?? null,
          effective.fullPinyin ?? null,
          effective.pinyinInitials ?? "",
          effective.pinyinIndexVersion ?? this.pinyin.version,
          effective.mobile ?? null,
          effective.companyPhone ?? null,
          syncedAt,
        );
        deleteFts.run(accountId, effective.id);
        insertFts.run(contactSearchText(effective), accountId, effective.id);
      }
    })();
  }

  ensurePinyinIndex(accountId: string, limit = 100): number {
    const rows = this.db.prepare(`
      SELECT c.*, f.search_text AS prior_search_text
      FROM directory_active_contacts c
      LEFT JOIN directory_contacts_fts f
        ON f.rowid = c.storage_id
      WHERE c.account_id = ? AND c.pinyin_index_version < ? LIMIT ?
    `).all(accountId, this.pinyin.version, limit) as Record<string, unknown>[];
    if (rows.length === 0) return 0;

    const updateContact = this.db.prepare(`
      UPDATE directory_contacts
      SET full_pinyin = ?, pinyin_initials = ?, pinyin_index_version = ?
      WHERE account_id = ? AND id = ?
    `);
    const deleteFts = this.db.prepare(
      "DELETE FROM directory_contacts_fts WHERE rowid = (SELECT storage_id FROM directory_active_contacts WHERE account_id = ? AND id = ?)",
    );
    const insertFts = this.db.prepare(`
      INSERT INTO directory_contacts_fts (rowid, account_id, contact_id, search_text)
      SELECT storage_id, account_id, id, ? FROM directory_active_contacts WHERE account_id = ? AND id = ?
    `);

    this.db.transaction(() => {
      for (const row of rows) {
        const priorSearchText = optionalString(row.prior_search_text);
        const item = withPinyinIndex({
          id: String(row.id),
          name: String(row.name),
          email: String(row.email),
          aliases: readAliases(row.aliases_json),
          departmentId: optionalString(row.department_id),
          departmentPath: optionalString(row.department_path),
          title: optionalString(row.title),
          fullPinyin: optionalString(row.full_pinyin),
          pinyinInitials: optionalString(row.pinyin_initials),
          mobile: optionalString(row.mobile),
          companyPhone: optionalString(row.company_phone),
          searchTerms: priorSearchText ? [priorSearchText] : undefined,
        }, this.pinyin);
        updateContact.run(
          item.fullPinyin ?? "",
          item.pinyinInitials ?? "",
          item.pinyinIndexVersion ?? this.pinyin.version,
          accountId,
          item.id,
        );
        deleteFts.run(accountId, item.id);
        insertFts.run(contactSearchText(item), accountId, item.id);
      }
    })();
    return rows.length;
  }

  listDepartments(accountId: string, parentId?: string): DirectoryDepartment[] {
    const rows = parentId === undefined
      ? this.db.prepare(`
          SELECT * FROM directory_active_departments
          WHERE account_id = ? AND parent_id IS NULL
          ORDER BY name
        `).all(accountId)
      : this.db.prepare(`
          SELECT * FROM directory_active_departments
          WHERE account_id = ? AND parent_id = ?
          ORDER BY name
        `).all(accountId, parentId);
    return (rows as Record<string, unknown>[]).map(rowToDepartment);
  }

  searchContacts(
    accountId: string,
    query: string,
    options: DirectoryContactQueryOptions = {},
  ): DirectoryContactSummary[] {
    const limit = Math.max(1, Math.floor(options.limit ?? 20));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const trimmed = query.trim();
    const departmentScope = buildDepartmentScope(accountId, options);
    if (!trimmed) {
      const rows = this.db.prepare(`
        ${departmentScope.cte}
        SELECT c.* FROM directory_active_contacts c
        WHERE c.account_id = ?
          ${departmentScope.condition}
        ORDER BY c.name LIMIT ? OFFSET ?
      `).all(
        ...departmentScope.leadingParams,
        accountId,
        ...departmentScope.filterParams,
        limit,
        offset,
      );
      return (rows as Record<string, unknown>[]).map(rowToContact);
    }

    const terms = trimmed.split(/\s+/).filter(Boolean).slice(0, 8);
    if (terms.some((term) => [...term].length < 3)) {
      const searchable = `
        c.name || ' ' || c.email || ' ' || c.aliases_json || ' ' ||
        COALESCE(c.full_pinyin, '') || ' ' || COALESCE(c.pinyin_initials, '') || ' ' ||
        COALESCE(c.department_path, '') || ' ' || COALESCE(c.title, '')
      `;
      const termConditions = terms.map(() => `(${searchable}) LIKE ?`).join(" AND ");
      const rows = this.db.prepare(`
        ${departmentScope.cte}
        SELECT c.* FROM directory_active_contacts c
        WHERE c.account_id = ?
          ${departmentScope.condition}
          AND ${termConditions}
        ORDER BY c.name LIMIT ? OFFSET ?
      `).all(
        ...departmentScope.leadingParams,
        accountId,
        ...departmentScope.filterParams,
        ...terms.map((term) => `%${term}%`),
        limit,
        offset,
      );
      return (rows as Record<string, unknown>[]).map(rowToContact);
    }

    const rows = this.db.prepare(`
      ${departmentScope.cte}
      SELECT c.*
      FROM directory_contacts_fts f
      JOIN directory_active_contacts c
        ON c.storage_id = f.rowid
      WHERE f.account_id = ?
        AND directory_contacts_fts MATCH ?
        ${departmentScope.condition}
      ORDER BY bm25(directory_contacts_fts), c.name
      LIMIT ? OFFSET ?
    `).all(
      ...departmentScope.leadingParams,
      accountId,
      quoteFts(trimmed),
      ...departmentScope.filterParams,
      limit,
      offset,
    );
    return (rows as Record<string, unknown>[]).map(rowToContact);
  }

  countContacts(
    accountId: string,
    query: string,
    options: DirectoryContactQueryOptions = {},
  ): number {
    const trimmed = query.trim();
    const departmentScope = buildDepartmentScope(accountId, options);
    if (!trimmed) {
      const row = this.db.prepare(`
        ${departmentScope.cte}
        SELECT COUNT(*) AS total FROM directory_active_contacts c
        WHERE c.account_id = ?
          ${departmentScope.condition}
      `).get(
        ...departmentScope.leadingParams,
        accountId,
        ...departmentScope.filterParams,
      );
      return Number((row as { total?: unknown } | undefined)?.total ?? 0);
    }

    const terms = trimmed.split(/\s+/).filter(Boolean).slice(0, 8);
    if (terms.some((term) => [...term].length < 3)) {
      const searchable = `
        c.name || ' ' || c.email || ' ' || c.aliases_json || ' ' ||
        COALESCE(c.full_pinyin, '') || ' ' || COALESCE(c.pinyin_initials, '') || ' ' ||
        COALESCE(c.department_path, '') || ' ' || COALESCE(c.title, '')
      `;
      const termConditions = terms.map(() => `(${searchable}) LIKE ?`).join(" AND ");
      const row = this.db.prepare(`
        ${departmentScope.cte}
        SELECT COUNT(*) AS total FROM directory_active_contacts c
        WHERE c.account_id = ?
          ${departmentScope.condition}
          AND ${termConditions}
      `).get(
        ...departmentScope.leadingParams,
        accountId,
        ...departmentScope.filterParams,
        ...terms.map((term) => `%${term}%`),
      );
      return Number((row as { total?: unknown } | undefined)?.total ?? 0);
    }

    const row = this.db.prepare(`
      ${departmentScope.cte}
      SELECT COUNT(*) AS total
      FROM directory_contacts_fts f
      JOIN directory_active_contacts c
        ON c.storage_id = f.rowid
      WHERE f.account_id = ?
        AND directory_contacts_fts MATCH ?
        ${departmentScope.condition}
    `).get(
      ...departmentScope.leadingParams,
      accountId,
      quoteFts(trimmed),
      ...departmentScope.filterParams,
    );
    return Number((row as { total?: unknown } | undefined)?.total ?? 0);
  }

  findByEmail(accountId: string, email: string): DirectoryContactSummary | null {
    const row = this.db.prepare(`
      SELECT * FROM directory_active_contacts
      WHERE account_id = ? AND (
        email = ? COLLATE NOCASE OR EXISTS (
          SELECT 1 FROM json_each(aliases_json) WHERE value = ? COLLATE NOCASE
        )
      ) LIMIT 1
    `).get(accountId, email, email) as Record<string, unknown> | undefined;
    return row ? rowToContact(row) : null;
  }

  findNamesByEmails(accountId: string, emails: string[]): Map<string, string> {
    const normalized = Array.from(new Set(
      emails.map((email) => email.trim().toLocaleLowerCase()).filter(Boolean),
    ));
    if (normalized.length === 0) return new Map();
    const rows = this.db.prepare(`
      SELECT LOWER(email) AS requested_email, name AS contact_name
      FROM directory_active_contacts
      WHERE account_id = ?
        AND email COLLATE NOCASE IN (
          SELECT value COLLATE NOCASE FROM json_each(?)
        )
    `).all(accountId, JSON.stringify(normalized)) as Array<{
      requested_email: string;
      contact_name: string;
    }>;
    const names = new Map<string, string>();
    for (const row of rows) {
      if (!names.has(row.requested_email)) {
        names.set(row.requested_email, row.contact_name);
      }
    }
    return names;
  }

  findById(accountId: string, id: string): DirectoryContactSummary | null {
    const row = this.db.prepare(
      "SELECT * FROM directory_active_contacts WHERE account_id = ? AND id = ?",
    ).get(accountId, id) as Record<string, unknown> | undefined;
    return row ? rowToContact(row) : null;
  }

  getStatus(accountId: string): DirectorySyncStatus {
    const row = this.db.prepare(
      "SELECT * FROM directory_sync_status WHERE account_id = ?",
    ).get(accountId) as Record<string, unknown> | undefined;
    if (!row) {
      return {
        accountId,
        state: "idle",
        processedDepartments: 0,
        processedContacts: 0,
        updatedAt: this.now(),
      };
    }
    return {
      accountId,
      state: String(row.state) as DirectorySyncStatus["state"],
      phase: row.phase ? String(row.phase) as DirectorySyncStatus["phase"] : undefined,
      processedDepartments: Number(row.processed_departments),
      processedContacts: Number(row.processed_contacts),
      lastSuccessfulAt: row.last_successful_at ? String(row.last_successful_at) : undefined,
      updatedAt: String(row.updated_at),
      errorCode: row.error_code ? String(row.error_code) : undefined,
      errorMessage: row.error_message ? String(row.error_message) : undefined,
    };
  }

  setStatus(status: DirectorySyncStatus): void {
    this.db.prepare(`
      INSERT INTO directory_sync_status (
        account_id, state, phase, processed_departments, processed_contacts,
        last_successful_at, updated_at, error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        state = excluded.state,
        phase = excluded.phase,
        processed_departments = excluded.processed_departments,
        processed_contacts = excluded.processed_contacts,
        last_successful_at = excluded.last_successful_at,
        updated_at = excluded.updated_at,
        error_code = excluded.error_code,
        error_message = excluded.error_message
    `).run(
      status.accountId,
      status.state,
      status.phase ?? null,
      status.processedDepartments,
      status.processedContacts,
      status.lastSuccessfulAt ?? null,
      status.updatedAt,
      status.errorCode ?? null,
      status.errorMessage ?? null,
    );
  }
}

function buildDepartmentScope(
  accountId: string,
  options: DirectoryContactQueryOptions,
): {
  cte: string;
  condition: string;
  leadingParams: unknown[];
  filterParams: unknown[];
} {
  if (!options.departmentId) {
    return { cte: "", condition: "", leadingParams: [], filterParams: [] };
  }
  if (!options.includeDescendants) {
    return {
      cte: "",
      condition: "AND c.department_id = ?",
      leadingParams: [],
      filterParams: [options.departmentId],
    };
  }
  return {
    cte: `
      WITH RECURSIVE department_scope(id) AS (
        SELECT id
        FROM directory_active_departments
        WHERE account_id = ? AND id = ?

        UNION

        SELECT child.id
        FROM department_scope parent
        CROSS JOIN directory_active_departments child
        WHERE child.account_id = ? AND child.parent_id = parent.id
      )
    `,
    condition: "AND c.department_id IN (SELECT id FROM department_scope)",
    leadingParams: [accountId, options.departmentId, accountId],
    filterParams: [],
  };
}

function quoteFts(input: string): string {
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" AND ");
}

function contactSearchText(item: DirectoryContactInput): string {
  return [
    item.name,
    item.email,
    ...item.aliases,
    item.fullPinyin,
    item.pinyinInitials,
    ...(item.searchTerms ?? []),
    item.departmentPath,
    item.title,
  ].filter(Boolean).join(" ");
}

function withPinyinIndex(
  item: DirectoryContactInput,
  pinyin: DirectoryPinyinPort,
): DirectoryContactInput {
  const generated = pinyin.buildIndex(item.name);
  const providedFullPinyin = item.fullPinyin?.trim();
  const providedInitials = item.pinyinInitials?.trim();
  return {
    ...item,
    fullPinyin: generated.fullPinyin || providedFullPinyin || "",
    pinyinInitials: generated.pinyinInitials || providedInitials || "",
    pinyinIndexVersion: pinyin.version,
    searchTerms: Array.from(new Set([
      ...(item.searchTerms ?? []),
      providedFullPinyin,
      providedInitials,
      ...generated.searchTerms,
    ].filter((value): value is string => !!value))),
  };
}

function readAliases(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rowToDepartment(row: Record<string, unknown>): DirectoryDepartment {
  return {
    accountId: String(row.account_id),
    id: String(row.id),
    parentId: row.parent_id ? String(row.parent_id) : undefined,
    name: String(row.name),
    path: String(row.path),
    childCount: Number(row.child_count),
    syncedAt: String(row.synced_at),
  };
}

function rowToContact(row: Record<string, unknown>): DirectoryContactSummary {
  return {
    accountId: String(row.account_id),
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    aliases: JSON.parse(String(row.aliases_json ?? "[]")) as string[],
    departmentId: row.department_id ? String(row.department_id) : undefined,
    departmentPath: row.department_path ? String(row.department_path) : undefined,
    title: row.title ? String(row.title) : undefined,
    mobile: row.mobile ? String(row.mobile) : undefined,
    companyPhone: row.company_phone ? String(row.company_phone) : undefined,
  };
}
