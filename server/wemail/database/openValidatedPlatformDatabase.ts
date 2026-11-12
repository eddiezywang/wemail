import { openMailDatabase, validateMailDatabase, type MailDatabase } from "./Database.js";
import { MAIL_DATABASE_SCHEMA_VERSION } from "./Schema.generated.js";
import type { MailDatabaseClient } from "./MailDatabaseClient.js";

/** DB Service owns migrations and the full scan; the platform connection only checks identity. */
export async function openValidatedPlatformDatabase(
  databasePath: string,
  database: { checkIntegrity: NonNullable<MailDatabaseClient["checkIntegrity"]> },
): Promise<MailDatabase> {
  const integrity = await database.checkIntegrity();
  if (!integrity.valid || integrity.schemaVersion !== MAIL_DATABASE_SCHEMA_VERSION) {
    throw new Error("platform-database-integrity-check-failed");
  }
  const connection = openMailDatabase(databasePath, { fileMustExist: true, safeIntegers: false });
  try {
    if (validateMailDatabase(connection, { integrityCheck: false }).schemaVersion !== integrity.schemaVersion) {
      throw new Error("platform-database-schema-mismatch");
    }
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}
