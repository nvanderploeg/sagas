# Production configuration

`compose.yaml` runs PostgreSQL 16 and the published image `ghcr.io/nvanderploeg/sagas`, with the app
bound to `127.0.0.1:${SAGAS_PORT:-3290}` behind a TLS reverse proxy. The app container is read-only,
drops every capability and keeps nothing on disk; `/tmp` is a 1 GiB tmpfs that holds an upload while
an import runs.

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

## Constraints

- Run a single app replica. The import freeze, the Event Stream and its bus, the Webhook
  dispatcher and the embedding queue are per process.
- Migrations run at start under `pg_advisory_lock`; several pods starting together wait on it.
- The embedding model is in the image. No volume is needed.
