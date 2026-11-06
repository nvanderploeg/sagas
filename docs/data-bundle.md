# Data bundle

An Admin moves an instance with a Data bundle at `/admin`. Only a browser session of an Admin may
use it; an API token is refused. Export is `POST /admin/export`. Import is `POST /admin/import`
(chunked, same-origin, header `x-sagas-confirm: REPLACE ALL DATA`).

## Layout

```
manifest.json
db/sagas.db                  VACUUM INTO snapshot, never a copy of the live file
attachments/<path>           every file under the attachments directory, if it exists
```

`manifest.json`: `format` (1), `appVersion`, `createdAt`, `schema` (`level`: migrations applied,
`latest`: the newest migration's journal time), `files` (`path`, `size`, `sha256` for every other
entry) and `skipped` (`path`, `reason`: local files left out because they vanished mid-export or have a name import would refuse) and
`remoteAttachments` (`driver`, `key`: bytes kept in a bucket are listed, never copied).
The archive is zip64, streamed, with the manifest last.

The attachments directory is `attachments/` beside the database file (`attachmentsDir` in
`apps/web/src/lib/server/config.ts`). A local storage driver (SAGA-49) writes its bytes there and
needs no other change; a cloud driver supplies `remoteAttachments` to `exportBundle`.

## Import

Replace-everything, in two phases.

1. Staging. The browser posts the bundle as `POST /admin/import?id=<16 hex>&offset=<n>[&final=1]`
   chunks of 256 KiB, which fit adapter-node's default body limit; only one upload runs at a time (a
   second gets 409). Chunks are appended to disk under `SAGAS_IMPORT_MAX_BYTES`, and the final chunk
   triggers staging. It is
   refused unless: it is a zip with an unencrypted, stored or deflated directory; it has a
   manifest of a format this build reads; the manifest's schema is not newer than this build and
   the database's migration history is a prefix of this build's; every entry is listed in the
   manifest with a safe relative path (no `..`, absolute, backslash or empty segments), its size,
   CRC and sha256 match, and the unpacked total fits the limit (four times the upload cap) and the
   free disk; the database passes `integrity_check`. Files are written with exclusive create into a
   scratch directory, never by joining a path from the archive onto a live directory. The database
   is migrated to this build while still staged. The result is `import-pending/` beside the database.
2. Swap, at the next start, before the database opens. The current database is saved with
   `VACUUM INTO`, and the current attachments directory is moved, to
   `backups/pre-import-<time>/`; the staged files are renamed into place (the database last, with
   the old `-wal` and `-shm` removed). A crash mid-swap is finished on the next start. A failed swap
   never stops startup: the attachments are put back, `import-pending/` moves to `quarantine/`, and the
   server boots on current data. The newest 5 backups are kept. Scratch directories older than an hour
   are removed at start.

The server never swaps the live handle: the database, the embedding queue, the Webhook dispatcher
and the schedulers all hold the open connection, so the import waits for a restart and the portal
says so. The embedding worker thread holds no database handle; vectors live in the
`labour_vectors` table and travel with the snapshot (no SQLite extensions are loaded). Writes made
between staging and the restart are lost; discard the staged import to cancel.

Stats load lazily from `GET /admin/stats`, not with the page.

## Limits

- The attachments directory must be on the same filesystem as the database directory; a separate
  mount point there breaks the rename-based swap.
- Export takes its snapshot with a synchronous `VACUUM INTO`, which blocks the server until it
  finishes. Export during quiet hours on a large database.
