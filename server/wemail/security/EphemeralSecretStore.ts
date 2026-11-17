import type { SecretStore } from "./SecretStore.js";

/** Read-only, process-local secret view populated by Electron Main. */
export class EphemeralSecretStore implements SecretStore {
  private readonly entries: ReadonlyMap<string, string>;

  constructor(entries: Readonly<Record<string, string>>) {
    this.entries = new Map(Object.entries(entries));
  }

  isEncryptionAvailable(): boolean {
    return true;
  }

  getSecret(key: string): string | undefined {
    return this.entries.get(key);
  }

  saveSecret(): void {
    throw new Error("ephemeral-secret-store-is-read-only");
  }

  deleteSecret(): void {
    throw new Error("ephemeral-secret-store-is-read-only");
  }
}
