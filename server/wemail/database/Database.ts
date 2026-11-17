import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import {
  MAIL_DATABASE_SCHEMA_BLOCKS,
  MAIL_DATABASE_SCHEMA_VERSION,
} from "./Schema.generated.js";
import { MAIL_DATABASE_PLATFORM_SCHEMA_BLOCKS } from "./PlatformSchema.generated.js";
import { runMailDatabaseMigrations } from "./Migrations.js";

export const MAIL_DATABASE_FILENAME = "wemail.sqlite";
export type MailDatabase = Database.Database;

export interface OpenMailDatabaseOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
  safeIntegers?: boolean;
}

export interface ResolveCanonicalMailDatabaseOptions {
  baseDir?: string;
}

export function resolveMailDatabasePath(baseDir: string): string {
  return path.join(baseDir, MAIL_DATABASE_FILENAME);
}

export function resolveCanonicalMailDatabasePath(
  filePath?: string,
  options: ResolveCanonicalMailDatabaseOptions = {},
): string {
  if (filePath) return filePath;
  const baseDir = options.baseDir
    ?? process.env.WEMAIL_DATA_DIR
    ?? path.join(process.cwd(), ".wemail");
  return resolveMailDatabasePath(baseDir);
}

export function openMailDatabase(
  filePath: string,
  options: OpenMailDatabaseOptions = {},
): MailDatabase {
  const nativeBinding = resolveElectronNativeBinding();
  const db = new Database(filePath, {
    readonly: options.readonly ?? false,
    fileMustExist: options.fileMustExist ?? false,
    ...(nativeBinding ? { nativeBinding } : {}),
  });
  db.defaultSafeIntegers(options.safeIntegers ?? true);
  applyConnectionPragmas(db, options.readonly ?? false);
  return db;
}

export function createMailDatabase(
  filePath: string,
  options: Pick<OpenMailDatabaseOptions, "safeIntegers"> = {},
): MailDatabase {
  if (fs.existsSync(filePath)) {
    throw new Error(`Mail database already exists: ${filePath}`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = openMailDatabase(filePath, options);
  try {
    db.transaction(() => {
      for (const sql of MAIL_DATABASE_SCHEMA_BLOCKS) db.exec(sql);
      for (const sql of MAIL_DATABASE_PLATFORM_SCHEMA_BLOCKS) db.exec(sql);
      ensureCanonicalReferenceData(db);
      db.prepare("INSERT INTO db_meta (key, value) VALUES (?, ?)").run(
        "schema_version",
        String(MAIL_DATABASE_SCHEMA_VERSION),
      );
      db.prepare("INSERT INTO db_meta (key, value) VALUES (?, ?)").run(
        "created_at_ms",
        String(Date.now()),
      );
      runMailDatabaseMigrations(db);
    })();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Canonical-only convenience for local composition and isolated tests.
 * Existing files must carry the canonical base schema version and pass SQLite
 * integrity checks; ordered application migrations are then applied in place.
 */
export function openOrCreateMailDatabase(
  filePath?: string,
  options: ResolveCanonicalMailDatabaseOptions = {},
): MailDatabase {
  const resolvedPath = resolveCanonicalMailDatabasePath(filePath, options);
  if (!fs.existsSync(resolvedPath)) {
    return createMailDatabase(resolvedPath, { safeIntegers: false });
  }

  const db = openMailDatabase(resolvedPath, {
    fileMustExist: true,
    safeIntegers: false,
  });
  try {
    const validation = validateMailDatabase(db);
    const valid =
      validation.schemaVersion === MAIL_DATABASE_SCHEMA_VERSION
      && validation.quickCheck.length === 1
      && validation.quickCheck[0] === "ok"
      && validation.foreignKeyErrors.length === 0;
    if (!valid) {
      throw new Error(
        `Incompatible mail database at ${resolvedPath}. `
        + `Expected canonical schema ${MAIL_DATABASE_SCHEMA_VERSION}, `
        + `found ${validation.schemaVersion ?? "unknown"}. `
        + "Run npm run reset:demo-data and sign in again.",
      );
    }
    runMailDatabaseMigrations(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export interface MailDatabaseValidation {
  quickCheck: string[];
  foreignKeyErrors: Array<Record<string, unknown>>;
  schemaVersion: number | null;
}

export function validateMailDatabase(
  db: MailDatabase,
  options: { integrityCheck?: boolean } = {},
): MailDatabaseValidation {
  // quick_check + foreign_key_check are full-DB scans whose cost scales with
  // database size and disk/cache state (a 450MB DB takes ~6-9s warm, far more
  // cold). They gate the writer lane's readiness, so on a large cold database
  // they blow the 30s startup budget. Callers on the startup hot path pass
  // { integrityCheck: false } to run only the cheap schema_version gate; the
  // full integrity scan still runs inside runMailDatabaseMigrations whenever a
  // migration actually applies (assertMigrationIntegrity), and foreign_keys=ON
  // prevents new FK violations, so the per-startup sweep is redundant in the
  // common no-migration case.
  const runIntegrityCheck = options.integrityCheck !== false;
  const quickCheck = runIntegrityCheck
    ? (db.pragma("quick_check") as Array<{ quick_check: string }>).map((row) => row.quick_check)
    : [];
  const foreignKeyErrors = runIntegrityCheck
    ? (db.pragma("foreign_key_check") as Array<Record<string, unknown>>)
    : [];
  const schemaVersionRow = db.prepare(
    "SELECT value FROM db_meta WHERE key = 'schema_version'",
  ).get() as { value: string } | undefined;
  const schemaVersion = schemaVersionRow ? Number.parseInt(schemaVersionRow.value, 10) : null;
  return {
    quickCheck,
    foreignKeyErrors,
    schemaVersion: Number.isFinite(schemaVersion) ? schemaVersion : null,
  };
}

function applyConnectionPragmas(db: MailDatabase, readonly: boolean): void {
  db.pragma("foreign_keys = ON");
  db.pragma("trusted_schema = OFF");
  db.pragma(`busy_timeout = ${readonly ? 250 : 5000}`);
  // Desktop-local mail DB: the main store is typically tens of MB, so a
  // 64MB mmap reservation on every connection (writer + reader) is wasted
  // private/virtual memory. 16MB of mapped pages plus an 8MB page cache
  // covers interactive queries; larger queries spill to ordinary reads.
  db.pragma("cache_size = -8192");
  db.pragma("mmap_size = 16777216");
  db.pragma("temp_store = MEMORY");
  if (readonly) {
    db.pragma("query_only = ON");
    return;
  }
  db.pragma("journal_mode = WAL");
  // WAL + synchronous=NORMAL: commits no longer block on a per-transaction
  // fsync (only the WAL file is synced at checkpoint). A power failure may
  // drop the last few un-checkpointed transactions, but the database stays
  // uncorrupted and mail state is re-derivable from IMAP — an acceptable
  // trade for a local-first desktop client. This is the single biggest lever
  // for the writer lane: under the AI backlog every claim/mutate/artifact
  // commit was paying an fsync (~100ms+ on Windows), which saturated the one
  // writer thread and starved interactive writes (mark-read, persistBody).
  db.pragma("synchronous = NORMAL");
  db.pragma("wal_autocheckpoint = 1000");
}

function ensureCanonicalReferenceData(db: MailDatabase): void {
  const categoryTable = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mail_system_categories'",
  ).get();
  if (!categoryTable) return;
  const insertCategory = db.prepare(`
    INSERT INTO mail_system_categories (
      key, display_name, sort_order, is_enabled
    ) VALUES (?, ?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET
      display_name = excluded.display_name,
      sort_order = excluded.sort_order
  `);
  db.transaction(() => {
    insertCategory.run("important", "重要", 10);
    insertCategory.run("action_required", "待处理", 20);
    insertCategory.run("invoice", "发票", 30);
  })();
}

function resolveElectronNativeBinding(): string | undefined {
  if (!process.versions.electron) return undefined;
  const modules = process.versions.modules;
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  const roots = [
    process.cwd(),
    resourcesPath ? path.join(resourcesPath, "app.asar.unpacked") : undefined,
  ].filter((value): value is string => !!value);
  for (const root of roots) {
    const candidate = path.join(
      root,
      "node_modules",
      "better-sqlite3",
      "bin",
      `${process.platform}-${process.arch}-${modules}`,
      "better-sqlite3.node",
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  // Packaged builds ship the Electron-ABI binding at build/Release: the
  // production dependency stage is installed with --ignore-scripts, so the
  // bin/<triple> prebuild layout never exists there, and the packager copies
  // the verified Electron binding into build/Release (see
  // package-desktop-win-dir.mjs). Deliberately NOT probed for process.cwd():
  // in a dev checkout build/Release holds the Node-ABI binary, which would
  // crash Electron on load.
  if (resourcesPath) {
    for (const root of ["app", "app.asar.unpacked"]) {
      const candidate = path.join(
        resourcesPath,
        root,
        "node_modules",
        "better-sqlite3",
        "build",
        "Release",
        "better_sqlite3.node",
      );
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error(
    `better-sqlite3 Electron 原生绑定缺失：需要 ABI ${modules} ` +
      `(${process.platform}-${process.arch}-${modules})，但 ${roots
        .map((root) =>
          path.join(root, "node_modules", "better-sqlite3", "bin"),
        )
        .join(" 和 ")} 下都找不到。` +
      `运行 \`npm run ensure:desktop-native\` 重新编译；` +
      `若刚升级过 Electron（ABI ${modules}），本机需具备 node-gyp 工具链（VS Build Tools + Python）。`,
  );
}
