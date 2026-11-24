import fs from "node:fs";
import path from "node:path";
import type { SecretStore } from "../../server/wemail/security/SecretStore.js";
import { FileSecretStore } from "../../server/wemail/security/SecretStore.js";

export interface ElectronSecretEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

interface SecretEnvelope {
  version: number;
  entries: Record<string, string>;
  generations: Record<string, number>;
}

/**
 * One-time migration: decrypt the safeStorage envelope and copy every
 * secret into the shared file-backed store, so the desktop and the
 * headless MCP server read one set of auth files. The envelope is
 * renamed aside (kept for manual recovery); safeStorage-encrypted data
 * is never deleted. Runs only when safeStorage is available and the
 * envelope exists; already-migrated stores are a no-op.
 */
export function migrateElectronSecretsToFile(
  baseDir: string,
  encryption: ElectronSecretEncryption,
): void {
  const envelopePath = path.join(baseDir, "encrypted-secrets.json");
  if (!fs.existsSync(envelopePath)) return;
  if (!encryption.isEncryptionAvailable()) return;
  const store = new ElectronSecretStore(baseDir, encryption);
  const snapshot = store.snapshotEntries();
  const fileStore = new FileSecretStore({ baseDir });
  let migrated = 0;
  for (const [key, ciphertext] of Object.entries(snapshot.entries)) {
    if (fileStore.getSecret(key) !== undefined) continue;
    try {
      fileStore.saveSecret(key, encryption.decryptString(Buffer.from(ciphertext, "base64")));
      migrated += 1;
    } catch {
      // Undecryptable entries stay in the envelope; the account will
      // surface its normal credential-required flow.
    }
  }
  if (migrated > 0) {
    fs.renameSync(envelopePath, `${envelopePath}.migrated.${Date.now()}`);
  }
  // Generations must ride along with the values: Mail Core compares the
  // secret store's generation with the canonical DB's credential_generation
  // and rejects a lower one ("stale-credential-generation"), so a migration
  // that renumbers secrets bricks account configuration after an upgrade.
  for (const [key, generation] of Object.entries(snapshot.generations)) {
    fileStore.restoreSecretGeneration(key, generation);
  }
}

/**
 * Repair pass for clients whose migration already ran with a build that
 * dropped the envelope's generations (everything renumbered to 1): the
 * renamed-aside envelope still holds the true per-secret generations, and
 * its JSON needs no decryption to read. Idempotent — generations only
 * ever move up, so this is safe on every boot.
 */
export function restoreMigratedSecretGenerations(baseDir: string): void {
  let backups: string[];
  try {
    backups = fs.readdirSync(baseDir).filter((entry) =>
      entry.startsWith("encrypted-secrets.json.migrated."),
    );
  } catch {
    return;
  }
  if (backups.length === 0) return;
  const fileStore = new FileSecretStore({ baseDir });
  for (const entry of backups) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(baseDir, entry), "utf8"),
      ) as Partial<SecretEnvelope>;
      for (const [key, generation] of Object.entries(parsed.generations ?? {})) {
        if (typeof generation === "number" && generation >= 1) {
          fileStore.restoreSecretGeneration(key, generation);
        }
      }
    } catch {
      // Unreadable backup: skip it; the live envelope (if any) still gets
      // its generations carried by the regular migration.
    }
  }
}

export class ElectronSecretStore implements SecretStore {
  private readonly filePath: string;

  constructor(
    baseDir: string,
    private readonly encryption: ElectronSecretEncryption,
  ) {
    fs.mkdirSync(baseDir, { recursive: true });
    this.filePath = path.join(baseDir, "encrypted-secrets.json");
  }

  isEncryptionAvailable(): boolean {
    return this.encryption.isEncryptionAvailable();
  }

  saveSecret(key: string, value: string): void {
    if (!this.isEncryptionAvailable()) {
      throw new Error("encrypted-secret-store-unavailable");
    }
    const envelope = this.read();
    envelope.entries[key] = this.encryption
      .encryptString(value)
      .toString("base64");
    envelope.generations[key] = (envelope.generations[key] ?? 0) + 1;
    this.write(envelope);
  }

  getSecretGeneration(key: string): number {
    return this.read().generations[key] ?? 0;
  }

  /** Full envelope snapshot — used by the one-time file-store migration. */
  snapshotEntries(): { entries: Record<string, string>; generations: Record<string, number> } {
    const envelope = this.read();
    return { entries: { ...envelope.entries }, generations: { ...envelope.generations } };
  }

  getSecret(key: string): string | undefined {
    if (!this.isEncryptionAvailable()) return undefined;
    const envelope = this.read();
    const ciphertext = envelope.entries[key];
    if (!ciphertext) return undefined;
    try {
      return this.encryption.decryptString(Buffer.from(ciphertext, "base64"));
    } catch {
      // Preserve a complete snapshot for manual recovery, then remove only the
      // unreadable entry. One stale credential must not make unrelated account,
      // model, MCP, or bot credentials disappear with it.
      if (this.snapshotCorruptStore()) {
        delete envelope.entries[key];
        this.write(envelope);
      }
      return undefined;
    }
  }

  deleteSecret(key: string): void {
    if (!fs.existsSync(this.filePath)) return;
    const envelope = this.read();
    if (!(key in envelope.entries)) return;
    delete envelope.entries[key];
    envelope.generations[key] = (envelope.generations[key] ?? 0) + 1;
    this.write(envelope);
  }

  private read(): SecretEnvelope {
    if (!fs.existsSync(this.filePath)) {
      return { version: 1, entries: {}, generations: {} };
    }
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, "utf8"),
      ) as Partial<SecretEnvelope>;
      if (
        parsed.version !== 1 ||
        !parsed.entries ||
        typeof parsed.entries !== "object" ||
        Array.isArray(parsed.entries)
      ) {
        throw new Error("invalid encrypted secret envelope");
      }
      return {
        version: 1,
        entries: parsed.entries,
        generations:
          parsed.generations && typeof parsed.generations === "object"
            ? parsed.generations
            : {},
      } as SecretEnvelope;
    } catch {
      this.quarantine();
      // Match FileSecretStore's recovery policy: quarantine malformed state
      // and continue with an empty store. Callers will surface the normal
      // credential-required flow instead of a fatal boot dialog.
      return { version: 1, entries: {}, generations: {} };
    }
  }

  private write(envelope: SecretEnvelope): void {
    const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
    const temporary = `${this.filePath}.${nonce}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(envelope, null, 2)}\n`, {
      mode: 0o600,
    });
    if (process.platform === "win32" && fs.existsSync(this.filePath)) {
      const backup = `${this.filePath}.${nonce}.bak`;
      fs.renameSync(this.filePath, backup);
      try {
        fs.renameSync(temporary, this.filePath);
        fs.unlinkSync(backup);
      } catch (error) {
        if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
        fs.renameSync(backup, this.filePath);
        throw error;
      }
      return;
    }
    fs.renameSync(temporary, this.filePath);
  }

  private quarantine(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      fs.renameSync(this.filePath, `${this.filePath}.corrupt.${Date.now()}`);
    } catch {
      // Preserve the original if quarantine itself is unavailable.
    }
  }

  private snapshotCorruptStore(): boolean {
    if (!fs.existsSync(this.filePath)) return false;
    try {
      fs.copyFileSync(
        this.filePath,
        `${this.filePath}.corrupt.${Date.now()}`,
        fs.constants.COPYFILE_EXCL,
      );
      return true;
    } catch {
      // Keep the active store untouched if the recovery snapshot cannot be made.
      return false;
    }
  }
}
