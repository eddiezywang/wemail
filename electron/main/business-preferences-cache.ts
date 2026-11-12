import {
  DEFAULT_BUSINESS_PREFERENCES,
  type BusinessPreferences,
  type BusinessPreferencesSnapshot,
} from "../../shared/wemail/businessPreferences.js";
import type { MailDatabaseChangeEvent } from "../../shared/wemail/mailDatabaseProtocol.js";

const UNAVAILABLE_PREFERENCES: BusinessPreferences = {
  ...DEFAULT_BUSINESS_PREFERENCES,
  newMailNotifications: false,
  actionRequiredNotifications: false,
  notificationSound: false,
  notificationContentMode: "count-only",
};

export class BusinessPreferencesCache {
  private preferences = UNAVAILABLE_PREFERENCES;
  private revision = 0;
  private attemptedRevision = 0;
  private stale = true;
  private nextRetryAt = Infinity;
  private disposed = false;
  private inFlight: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly database: {
    getBusinessPreferences(): Promise<BusinessPreferencesSnapshot>;
    onChanged(listener: (event: MailDatabaseChangeEvent) => void): () => void;
  }, private readonly onError: (error: unknown) => void) {}

  start(): Promise<void> {
    this.unsubscribe ??= this.database.onChanged((event) => {
      if (event.resetRequired || event.changes.some((change) =>
        change.entityType === "setting" && change.entityPublicId === "business-preferences")) {
        void this.refresh();
      }
    });
    return this.refresh();
  }

  get(): BusinessPreferences {
    if (this.stale && this.unsubscribe && !this.inFlight && Date.now() >= this.nextRetryAt) void this.refresh();
    // Unknown settings must not expose mail content while a disabled/private choice is loading.
    return { ...(this.stale ? UNAVAILABLE_PREFERENCES : this.preferences) };
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.revision += 1;
    this.stale = true;
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      while (!this.disposed) {
        const revision = this.revision;
        try {
          const snapshot = await this.database.getBusinessPreferences();
          this.attemptedRevision = revision;
          if (this.disposed) return;
          if (revision !== this.revision) continue;
          this.preferences = snapshot.preferences;
          this.stale = false;
          this.nextRetryAt = Infinity;
          return;
        } catch (error) {
          this.attemptedRevision = revision;
          this.nextRetryAt = Date.now() + 5_000;
          this.onError(error);
          return;
        }
      }
    })().finally(() => {
      this.inFlight = null;
      if (!this.disposed && this.revision > this.attemptedRevision) void this.refresh();
    });
    return this.inFlight;
  }
}
