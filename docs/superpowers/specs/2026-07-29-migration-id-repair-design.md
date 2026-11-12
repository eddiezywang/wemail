# Database Migration ID Repair Design

## Problem

Some local WeMail databases ran three enterprise smart-classification migrations
before their final migration IDs were assigned. Those databases contain these
records in `schema_migrations`:

- `60: enterprise_smart_topic_candidates`
- `61: smart_tag_creation_source`
- `62: system_classification_overrides`

The released migration list now assigns those migrations to IDs 62, 63, and 64.
IDs 60 and 61 belong to MCP migrations. Because the runner currently checks only
the numeric ID, it skips the real migrations 60 and 61, then attempts to replay
the smart-tag schema and fails with `duplicate column name: creation_source`.

## Chosen Approach

Repair migration metadata by exact migration name before the normal migration
loop runs. In one transaction, process the provisional mappings in descending
order:

- `62 -> 64` for `system_classification_overrides`
- `61 -> 63` for `smart_tag_creation_source`
- `60 -> 62` for `enterprise_smart_topic_candidates`

Descending order frees each destination before the next mapping. If a final ID
already contains the same migration name, remove the redundant provisional
record. If a destination contains an unexpected migration after the known
provisional records have been moved, fail with a precise error instead of
silently changing unrelated migration history.

After repair, the existing migration runner executes the real migrations 60 and
61 and skips the already-applied smart-classification migrations at 62–64.

## Data Safety

The repair changes only rows in `schema_migrations`. It does not drop, recreate,
or rewrite email, tag, classification, or application-message data. The repair
is transactional and idempotent, so interrupted or repeated application startup
cannot leave partially remapped migration metadata.

The existing partial-schema repair for `smart_tag_creation_source` remains as a
secondary recovery path for databases where the column alteration succeeded but
the migration record was never written.

## Testing

Add focused database tests covering:

1. The complete provisional `60/61/62` history is remapped to `62/63/64`.
2. Current migration IDs 60 and 61 are left untouched.
3. Re-running the repair is a no-op.
4. A partially applied `creation_source` schema remains recoverable.
5. A reconstructed legacy database can run the full migration loop and ends
   with the expected migration names and schema objects.

Desktop acceptance must verify that the existing user database reaches
`loadURL-done` and `ready` in `startup.log` without deleting the database.
