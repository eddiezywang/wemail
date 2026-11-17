import type { MailDatabase } from "../database/Database.js";
import { DEFAULT_BUSINESS_PREFERENCES, validateBusinessPreferences, type BusinessPreferences } from "../../../shared/wemail/businessPreferences.js";
export { DEFAULT_BUSINESS_PREFERENCES, validateBusinessPreferences, type BusinessPreferences } from "../../../shared/wemail/businessPreferences.js";

export class BusinessPreferenceService {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  isStored(): boolean {
    return !!this.db.prepare(
      "SELECT id FROM business_preferences WHERE id = 'default'",
    ).get();
  }

  get(): BusinessPreferences {
    const row = this.db.prepare(
      "SELECT preferences_json FROM business_preferences WHERE id = 'default'",
    ).get() as { preferences_json: string } | undefined;
    if (!row) return { ...DEFAULT_BUSINESS_PREFERENCES };
    try {
      return validateBusinessPreferences(JSON.parse(row.preferences_json));
    } catch {
      return { ...DEFAULT_BUSINESS_PREFERENCES };
    }
  }

  save(patch: Partial<BusinessPreferences>): BusinessPreferences {
    const next = validateBusinessPreferences({ ...this.get(), ...patch });
    this.db.prepare(
      `INSERT INTO business_preferences (id, preferences_json, updated_at)
       VALUES ('default', @json, @now)
       ON CONFLICT(id) DO UPDATE SET
         preferences_json = excluded.preferences_json,
         updated_at = excluded.updated_at`,
    ).run({ json: JSON.stringify(next), now: this.now() });
    return next;
  }
}
