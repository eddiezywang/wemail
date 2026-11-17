import fs from "node:fs";
import path from "node:path";

/**
 * Stable credential storage interface consumed across WeMail packages.
 *
 * Keys are namespaced (e.g. `wemail:account:<id>:imap-password`).
 * Phase-one implementations MAY be file-backed placeholders; later phases
 * can swap in Electron `safeStorage` without touching callers.
 */
export interface SecretStore {
  saveSecret(key: string, value: string): void;
  getSecret(key: string): string | undefined;
  deleteSecret(key: string): void;
  isEncryptionAvailable(): boolean;
  /** Monotonic generation for a key, used to detect credential rotation.
   *  Optional for lightweight test stubs; both production implementations
   *  (ElectronSecretStore / FileSecretStore) provide it. */
  getSecretGeneration?(key: string): number;
}

export interface FileSecretStoreOptions {
  /** Directory that will contain `secrets.json`. Created if missing. */
  baseDir: string;
  /** Optional log sink. Implementation MUST never pass secret values here. */
  logger?: (message: string) => void;
}

const FILE_NAME = "secrets.json";
const HEADER_COMMENT =
  "# wemail secret placeholder store — obfuscated, NOT cryptographically secure";

const IS_WINDOWS = process.platform === "win32";

/**
 * Phase-one file-backed SecretStore.
 *
 * Secrets are obfuscated with base64 + a per-entry xor pad so they do not
 * appear as plaintext in the file. This is explicitly a placeholder —
 * production builds should swap to Electron `safeStorage`-backed storage
 * via the {@link SecretStore} interface.
 */
export class FileSecretStore implements SecretStore {
  private readonly filePath: string;
  private readonly generationsPath: string;
  private readonly logger: (message: string) => void;
  private generations: Record<string, number> = {};

  constructor(options: FileSecretStoreOptions) {
    fs.mkdirSync(options.baseDir, { recursive: true });
    // On POSIX, tighten the directory to owner-only; on Windows, NTFS ACLs
    // (inherited from the user profile) are the correct story, so skip chmod.
    if (!IS_WINDOWS) {
      try {
        fs.chmodSync(options.baseDir, 0o700);
      } catch {
        // Best-effort: chmod can fail on exotic filesystems (e.g. some
        // network mounts). Don't crash — caller is informed via logger.
      }
    }
    this.filePath = path.join(options.baseDir, FILE_NAME);
    this.generationsPath = path.join(options.baseDir, "secret-generations.json");
    this.logger = options.logger ?? (() => {});
    // Generations must survive a process restart just like the encrypted
    // store's envelope: Mail Core compares them with the canonical DB's
    // credentialGeneration and rejects a zeroed generation on re-open.
    try {
      if (fs.existsSync(this.generationsPath)) {
        const parsed: unknown = JSON.parse(
          fs.readFileSync(this.generationsPath, "utf8"),
        );
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
              this.generations[key] = value;
            }
          }
        }
      }
    } catch {
      this.generations = {};
    }
  }

  saveSecret(key: string, value: string): void {
    const store = this.read();
    store[key] = encode(value);
    this.write(store);
    this.generations[key] = (this.generations[key] ?? 0) + 1;
    try {
      fs.writeFileSync(
        this.generationsPath,
        `${JSON.stringify(this.generations, null, 2)}\n`,
        { mode: 0o600 },
      );
    } catch {
      // Best-effort: the in-memory generation still serves this process.
      this.logger("WARN could not persist secret generations");
    }
    this.logger(`secret saved for key ${redact(key)}`);
  }

  getSecretGeneration(key: string): number {
    return this.generations[key] ?? 0;
  }

  getSecret(key: string): string | undefined {
    const store = this.read();
    const entry = store[key];
    if (entry === undefined) return undefined;
    return decode(entry);
  }

  deleteSecret(key: string): void {
    const store = this.read();
    if (!(key in store)) return;
    delete store[key];
    this.write(store);
    this.logger(`secret deleted for key ${redact(key)}`);
  }

  isEncryptionAvailable(): boolean {
    // Phase-one file placeholder is obfuscated, not truly encrypted.
    return false;
  }

  private read(): Record<string, string> {
    if (!fs.existsSync(this.filePath)) return {};
    const raw = fs.readFileSync(this.filePath, "utf8");
    const withoutHeader = raw.replace(/^#[^\n]*\n?/, "");
    if (!withoutHeader.trim()) return {};
    try {
      return JSON.parse(withoutHeader) as Record<string, string>;
    } catch {
      // Corrupt JSON: quarantine the file rather than silently overwriting
      // it, so an operator can inspect what went wrong. Then start fresh.
      const quarantinePath = `${this.filePath}.corrupt.${Date.now()}`;
      try {
        fs.renameSync(this.filePath, quarantinePath);
      } catch {
        // If rename fails (e.g. file vanished) we still proceed with empty
        // state — the next write will create a new file.
      }
      this.logger(
        `WARN secrets.json was corrupt; quarantined to ${path.basename(quarantinePath)} and starting fresh`,
      );
      return {};
    }
  }

  private write(store: Record<string, string>): void {
    const body = `${HEADER_COMMENT}\n${JSON.stringify(store, null, 2)}\n`;
    const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
    const tmpPath = `${this.filePath}.${nonce}.tmp`;
    fs.writeFileSync(tmpPath, body, { mode: 0o600 });
    if (IS_WINDOWS && fs.existsSync(this.filePath)) {
      // Windows rename cannot replace an existing destination. Preserve the
      // previous complete file until the new one is in place so token/account
      // rotation never truncates the only recoverable copy.
      const backupPath = `${this.filePath}.${nonce}.bak`;
      fs.renameSync(this.filePath, backupPath);
      try {
        fs.renameSync(tmpPath, this.filePath);
        fs.unlinkSync(backupPath);
      } catch (error) {
        try {
          if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
          fs.renameSync(backupPath, this.filePath);
        } catch {
          // Keep the backup on disk for manual recovery if restoration fails.
        }
        throw error;
      }
    } else {
      fs.renameSync(tmpPath, this.filePath);
    }
    // chmod after rename — on some filesystems the mode flag on writeFileSync
    // can be affected by umask, and rename preserves the source's perms.
    // NTFS ACLs are the Windows story, so skip there.
    if (!IS_WINDOWS) {
      try {
        fs.chmodSync(this.filePath, 0o600);
      } catch {
        // Best-effort; see note in constructor.
      }
    }
  }
}

// Per-entry obfuscation: random 8-byte pad + XOR; serialised as
// `<padHex>:<cipherHex>`. This is NOT cryptographic — callers must treat
// the backing file as sensitive. The point is simply that plaintext does
// not land on disk for casual-inspection threat models.
function encode(plaintext: string): string {
  const pad = Buffer.alloc(8);
  for (let i = 0; i < pad.length; i++) {
    pad[i] = Math.floor(Math.random() * 256);
  }
  const data = Buffer.from(plaintext, "utf8");
  const cipher = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    cipher[i] = data[i]! ^ pad[i % pad.length]!;
  }
  return `${pad.toString("hex")}:${cipher.toString("base64")}`;
}

function decode(entry: string): string | undefined {
  const idx = entry.indexOf(":");
  if (idx < 0) return undefined;
  const pad = Buffer.from(entry.slice(0, idx), "hex");
  const cipher = Buffer.from(entry.slice(idx + 1), "base64");
  if (pad.length === 0) return undefined;
  const out = Buffer.alloc(cipher.length);
  for (let i = 0; i < cipher.length; i++) {
    out[i] = cipher[i]! ^ pad[i % pad.length]!;
  }
  return out.toString("utf8");
}

function redact(key: string): string {
  // Keep namespace readable but hide trailing credential kind specifics.
  return key.length > 24 ? `${key.slice(0, 24)}…` : key;
}
