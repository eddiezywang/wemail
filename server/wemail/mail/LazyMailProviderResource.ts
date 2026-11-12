import type { MailProvider } from "./MailProvider.js";

export class LazyMailProviderResource<T extends MailProvider = MailProvider> {
  private provider: T | null = null;
  private lastUsedAt = 0;

  constructor(
    private readonly factory: () => T,
    private readonly idleTimeoutMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(): T {
    this.lastUsedAt = this.now();
    this.provider ??= this.factory();
    return this.provider;
  }

  isActive(): boolean {
    return this.provider !== null;
  }

  async releaseIfIdle(workActive = false): Promise<boolean> {
    if (!this.provider || workActive) return false;
    if (this.now() - this.lastUsedAt < this.idleTimeoutMs) return false;
    const provider = this.provider;
    this.provider = null;
    await provider.disconnect();
    return true;
  }

  async close(): Promise<void> {
    const provider = this.provider;
    this.provider = null;
    if (provider) await provider.disconnect();
  }
}
