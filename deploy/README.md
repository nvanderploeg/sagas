# Production configuration

`compose.yaml` runs PostgreSQL 16 and the published image `ghcr.io/nvanderploeg/sagas`, with the app
bound to `127.0.0.1:${SAGAS_PORT:-3290}` behind a TLS reverse proxy. The app container is read-only,
drops every capability and keeps nothing on disk; `/tmp` is a 1 GiB tmpfs that holds an upload and its
unpacked files while an import runs.

```sh
docker compose --env-file .env -f deploy/compose.yaml up -d
```

Set `POSTGRES_PASSWORD`, `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env`. The Admin is seeded on an
empty database and changes the password at first sign-in.

## An external database

Replace the `db` service and `DATABASE_URL` for a shared server over the internet:

```
DATABASE_URL=postgres://user:pw@host:5432/sagas?sslmode=verify-full
```

- `pg` reads `sslmode=require|prefer|verify-ca` as full verification and `no-verify` as none;
  `uselibpqcompat=true` restores libpq meanings. A private CA: `sslrootcert=/path/ca.pem`, mounted
  into the container.
- Passwords are spliced into the URL unencoded: use hex.
- Poolers: sagas sends no startup `options`, only `SET` statements after connecting. Transaction
  pooling is not supported (sagas holds a session advisory lock while it migrates and a transaction
  advisory lock per write); use session pooling or a direct connection.

## Import size and availability

`SAGAS_IMPORT_MAX_BYTES` (default 200 MiB) caps the upload. An import keeps the upload and the
unpacked files, which may total four times the cap, in `/tmp`: up to five times the cap on the tmpfs,
and tmpfs pages count against `mem_limit` beside the app's own memory. To raise the cap to `N` bytes
set `tmpfs: /tmp:size=` to at least `5 * N` and `mem_limit` to at least that plus 512 MiB, in the
same change.

An import's `TRUNCATE` takes `ACCESS EXCLUSIVE` locks on every table and holds them until the
commit, so every request waits, including the container `HEALTHCHECK` (`/login` reads the
database). A long import turns the container unhealthy; compose does not restart on that, but an
orchestrator that does must be told to wait. A killed import rolls back whole. An export holds
`ACCESS SHARE` locks on the tables it has read until it ends, so an import started during a long
export waits for it, and every request arriving after the import queues behind that wait.

## Constraints

- Run a single app replica. The import freeze, the Event Stream and its bus, the Webhook
  dispatcher and the embedding queue are per process.
- Migrations run at start under `pg_advisory_lock`; several pods starting together wait on it.
- The embedding model is in the image. No volume is needed.
