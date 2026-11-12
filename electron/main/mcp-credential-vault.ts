import fs from "node:fs";
import path from "node:path";
import type {
  ManagedMcpCredential,
  ManagedMcpCredentialVault,
} from "../../server/wemail/mcp/ManagedMcpCredentialVault.js";

export interface McpCredentialEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

interface VaultEnvelope {
  version: 1;
  accountId: string;
  tokenId: string;
  ciphertext: string;
}

export class ElectronMcpCredentialVault implements ManagedMcpCredentialVault {
  private readonly filePath: string;

  constructor(
    baseDir: string,
    private readonly encryption: McpCredentialEncryption,
  ) {
    fs.mkdirSync(baseDir, { recursive: true });
    this.filePath = path.join(baseDir, "mcp-credential.json");
  }

  isAvailable(): boolean {
    return this.encryption.isEncryptionAvailable();
  }

  readStoredCredential(): ManagedMcpCredential | null {
    if (!fs.existsSync(this.filePath)) return null;
    const envelope = this.parseEnvelope(fs.readFileSync(this.filePath, "utf8"));
    return this.read(envelope.accountId);
  }

  read(accountId: string): ManagedMcpCredential | null {
    if (!this.isAvailable()) throw new Error("mcp-credential-unavailable");
    if (!fs.existsSync(this.filePath)) return null;
    try {
      const envelope = this.parseEnvelope(fs.readFileSync(this.filePath, "utf8"));
      if (envelope.accountId !== accountId) return null;
      const decrypted = JSON.parse(
        this.encryption.decryptString(Buffer.from(envelope.ciphertext, "base64")),
      ) as Partial<ManagedMcpCredential>;
      if (
        decrypted.version !== 1 ||
        decrypted.accountId !== envelope.accountId ||
        decrypted.tokenId !== envelope.tokenId ||
        typeof decrypted.token !== "string" ||
        !decrypted.token.startsWith(`wmcp_${envelope.tokenId}.`)
      ) {
        throw new Error("invalid managed MCP credential");
      }
      return decrypted as ManagedMcpCredential;
    } catch (error) {
      this.quarantine();
      throw new Error("mcp-credential-corrupt", { cause: error });
    }
  }

  save(credential: ManagedMcpCredential): void {
    if (!this.isAvailable()) throw new Error("mcp-credential-unavailable");
    const ciphertext = this.encryption
      .encryptString(JSON.stringify(credential))
      .toString("base64");
    const envelope: VaultEnvelope = {
      version: 1,
      accountId: credential.accountId,
      tokenId: credential.tokenId,
      ciphertext,
    };
    this.writeAtomic(`${JSON.stringify(envelope, null, 2)}\n`);
  }

  delete(accountId: string): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const envelope = this.parseEnvelope(fs.readFileSync(this.filePath, "utf8"));
      if (envelope.accountId !== accountId) return;
    } catch {
      // A corrupt vault must still be removable during reset/logout.
    }
    fs.unlinkSync(this.filePath);
  }

  private parseEnvelope(raw: string): VaultEnvelope {
    const value = JSON.parse(raw) as Partial<VaultEnvelope>;
    if (
      value.version !== 1 ||
      typeof value.accountId !== "string" ||
      typeof value.tokenId !== "string" ||
      typeof value.ciphertext !== "string"
    ) {
      throw new Error("invalid managed MCP credential envelope");
    }
    return value as VaultEnvelope;
  }

  private writeAtomic(body: string): void {
    const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
    const temporary = `${this.filePath}.${nonce}.tmp`;
    fs.writeFileSync(temporary, body, { mode: 0o600 });
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
    const target = `${this.filePath}.corrupt.${Date.now()}`;
    try {
      fs.renameSync(this.filePath, target);
    } catch {
      // Keep the original file for manual recovery if quarantine fails.
    }
  }
}
