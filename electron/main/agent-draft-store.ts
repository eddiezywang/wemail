import fs from "node:fs";
import path from "node:path";
import type { ElectronSecretEncryption } from "./electron-secret-store.js";

interface DraftEntry {
  ciphertext: string;
  expiresAt: number;
}

interface DraftEnvelope {
  version: 1;
  entries: Record<string, DraftEntry>;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_DRAFT_LENGTH = 100_000;

export class AgentDraftStore {
  private readonly filePath: string;

  constructor(
    baseDir: string,
    private readonly encryption: ElectronSecretEncryption,
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {
    fs.mkdirSync(baseDir, { recursive: true });
    this.filePath = path.join(baseDir, "agent-drafts.json");
  }

  get(accountId: string, conversationId: string): string | undefined {
    if (!this.encryption.isEncryptionAvailable()) return undefined;
    const envelope = this.read();
    const key = draftKey(accountId, conversationId);
    const entry = envelope.entries[key];
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      delete envelope.entries[key];
      this.write(envelope);
      return undefined;
    }
    try {
      return this.encryption.decryptString(Buffer.from(entry.ciphertext, "base64"));
    } catch {
      delete envelope.entries[key];
      this.write(envelope);
      return undefined;
    }
  }

  save(accountId: string, conversationId: string, text: string): boolean {
    if (!this.encryption.isEncryptionAvailable()) return false;
    if (!text) {
      this.delete(accountId, conversationId);
      return true;
    }
    const envelope = this.prune(this.read());
    envelope.entries[draftKey(accountId, conversationId)] = {
      ciphertext: this.encryption
        .encryptString(text.slice(0, MAX_DRAFT_LENGTH))
        .toString("base64"),
      expiresAt: this.now() + this.ttlMs,
    };
    this.write(envelope);
    return true;
  }

  delete(accountId: string, conversationId: string): void {
    const envelope = this.read();
    const key = draftKey(accountId, conversationId);
    if (!(key in envelope.entries)) return;
    delete envelope.entries[key];
    this.write(envelope);
  }

  clearAccount(accountId: string): void {
    const envelope = this.read();
    const prefix = `${encodeURIComponent(accountId)}:`;
    let changed = false;
    for (const key of Object.keys(envelope.entries)) {
      if (!key.startsWith(prefix)) continue;
      delete envelope.entries[key];
      changed = true;
    }
    if (changed) this.write(envelope);
  }

  private prune(envelope: DraftEnvelope): DraftEnvelope {
    const now = this.now();
    for (const [key, entry] of Object.entries(envelope.entries)) {
      if (entry.expiresAt <= now) delete envelope.entries[key];
    }
    return envelope;
  }

  private read(): DraftEnvelope {
    if (!fs.existsSync(this.filePath)) return { version: 1, entries: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<DraftEnvelope>;
      if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
        throw new Error("invalid-agent-draft-envelope");
      }
      return { version: 1, entries: parsed.entries } as DraftEnvelope;
    } catch {
      try {
        fs.renameSync(this.filePath, `${this.filePath}.corrupt.${this.now()}`);
      } catch {
        // Keep startup recoverable if quarantine itself fails.
      }
      return { version: 1, entries: {} };
    }
  }

  private write(envelope: DraftEnvelope): void {
    const temporary = `${this.filePath}.${process.pid}.${this.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    if (process.platform === "win32" && fs.existsSync(this.filePath)) {
      const backup = `${this.filePath}.${process.pid}.${this.now()}.bak`;
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
}

function draftKey(accountId: string, conversationId: string): string {
  return `${encodeURIComponent(accountId)}:${encodeURIComponent(conversationId)}`;
}
