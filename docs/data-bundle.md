# Data bundle

An Admin moves an instance with a Data bundle at `/admin`. Only a browser session of an Admin may
use it; an API token is refused. Export is `POST /admin/export`. Import is `POST /admin/import`
(chunked, same-origin, header `x-sagas-confirm: REPLACE ALL DATA`).

## Layout

```
manifest.json
db.ndjson        every table, one transaction snapshot
```

`manifest.json`: `format` (2), `service` (`sagas`), `appVersion`, `createdAt`, `schema` (`level`:
migrations in the build that wrote it, `latest`: the newest migration's journal time) and `files`
(`path`, `size`, `sha256` for every other entry). The archive is zip64 and streamed, with the manifest
last.

`db.ndjson` holds, per table in `apps/web/src/lib/server/admin/tables.ts` order, a header line
`{"table": "...", "columns": [...]}` and then one JSON array per row, values in column order. `json`
and `jsonb` values are their text, `bytea` values are base64, `bigint` epoch milliseconds are
numbers. The derived tables `labour_text` and `scroll_text` are not carried: import rebuilds them.
Nothing else lives outside the database; the server keeps no files that a Bundle would need.

Export reads every table inside one `REPEATABLE READ READ ONLY` transaction and streams it through
a cursor, so the Bundle is consistent however long it takes and holds no table in memory.

## Import

Replace-everything, in one request and one transaction.

1. Upload. The browser posts the bundle as `POST /admin/import?id=<16 hex>&offset=<n>[&final=1]`
   chunks of 256 KiB, which fit adapter-node's default body limit; only one upload runs at a time (a
   second gets 409). Chunks are appended to a file in the system temp directory under
   `SAGAS_IMPORT_MAX_BYTES`, and the final chunk starts the import.
2. Check, before anything is written. It is refused (422, or 409 for a newer schema) unless: it is a
   zip with an unencrypted, stored or deflated directory; its manifest names a format this build
   reads; the manifest's schema is not newer than this build; every entry is listed in the manifest
   with a safe relative path, its size, CRC and sha256 match, and the unpacked total fits four times
   the upload cap.
3. Replace. In one transaction that holds the writer lock (`pg_advisory_xact_lock`) and
   `TRUNCATE`s every table, rows are inserted in batches of at most 500 rows and 60 000 bound
   parameters, with every foreign key deferred to the commit. Ids are kept. After the last row the
   derived tables are rebuilt, every identity sequence is set above the largest imported id (an empty
   table restarts at 1), and `event_counter` is set to the largest of the imported counter, the largest imported `events.seq` and the counter this instance had before the import, so a seq already handed to a connected client is never reused. A
   failure rolls back and leaves the current data untouched. SQLSTATE classes 22 (data exception)
   and 23 (integrity violation) answer 422; anything else is a 500.

`TRUNCATE` takes `ACCESS EXCLUSIVE` locks, so every request that touches the database waits until the
commit. The server then closes every open Event Stream; clients reconnect and resume or reset.
Sessions, API tokens and OAuth Connections are part of the Bundle, so everyone is signed in or out as
the Bundle says. Webhook secrets stay encrypted: the target host needs the same `WEBHOOK_KEY`.

Nothing is kept of the data an import replaces. Export first if you may want it back.

## Legacy bundles (format 1)

The last SQLite build wrote `manifest.json` with `format` 1, `db/sagas.db` (a `VACUUM INTO` snapshot)
and optional `attachments/<path>` files. A format 1 bundle imports through the same path:

- The manifest's `schema.level` must be at most 25, the last SQLite migration.
- `db/sagas.db` is extracted to the temp directory, checked against its sha256 and `PRAGMA
quick_check`, and read read-only by `apps/web/src/lib/server/admin/legacy.ts`, the only module that
  loads `better-sqlite3`. Each table present in both databases is copied column by column; columns
  the new schema lacks are dropped, and a NOT NULL column without a default that the bundle lacks
  refuses the import. Ids, Labour keys, Aliases and Paths are kept.
- SQLite `0`/`1` become booleans, JSON text becomes `json`/`jsonb`, blobs become `bytea`.
- `events.seq` continues from the old `sqlite_sequence` value.
- `attachments/*` files are not imported: no code in either build stores attachments, so there is
  nothing to attach them to. The result reports how many were ignored.

## Limits

- The unpacked database must fit in the temp directory while it is read (legacy) or streamed
  (format 2 reads the zip in place). The container's `/tmp` is a tmpfs sized in `deploy/compose.yaml`.
- Run one app replica: the import lock only freezes this process's view of the Event Stream, the
  Event bus and the Webhook dispatcher are per process.
- Stats load lazily from `GET /admin/stats`, not with the page.
