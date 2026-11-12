import { randomUUID } from "node:crypto";
import type { ChannelDestination } from "../../../shared/wemail/channels.js";
import type { MailDatabase } from "../database/Database.js";

interface DestinationRow {
  id: string;
  profile_id: string;
  destination_type: ChannelDestination["type"];
  external_id: string;
  display_name: string | null;
  verified: number;
  created_at: string;
}

const fromRow = (row: DestinationRow): ChannelDestination => ({
  id: row.id,
  profileId: row.profile_id,
  type: row.destination_type,
  externalId: row.external_id,
  ...(row.display_name ? { displayName: row.display_name } : {}),
  verified: row.verified === 1,
  createdAt: row.created_at,
});

export class ChannelDestinationRepository {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  save(
    input: Omit<ChannelDestination, "id" | "createdAt"> & { id?: string },
  ): ChannelDestination {
    const id = input.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO channel_destinations (
          id, profile_id, destination_type, external_id, display_name,
          verified, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, destination_type, external_id) DO UPDATE SET
          display_name = excluded.display_name,
          verified = excluded.verified`,
      )
      .run(
        id,
        input.profileId,
        input.type,
        input.externalId,
        input.displayName ?? null,
        input.verified ? 1 : 0,
        this.now().toISOString(),
      );
    return this.list(input.profileId).find(
      (item) =>
        item.type === input.type && item.externalId === input.externalId,
    )!;
  }

  list(profileId: string): ChannelDestination[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM channel_destinations
           WHERE profile_id = ? ORDER BY created_at`,
        )
        .all(profileId) as DestinationRow[]
    ).map(fromRow);
  }

  get(id: string, profileId: string): ChannelDestination | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM channel_destinations WHERE id = ? AND profile_id = ?",
      )
      .get(id, profileId) as DestinationRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  remove(id: string, profileId: string): boolean {
    return (
      this.db
        .prepare(
          "DELETE FROM channel_destinations WHERE id = ? AND profile_id = ?",
        )
        .run(id, profileId).changes > 0
    );
  }
}
