# Production configuration

`compose.yaml` runs PostgreSQL 16 and the published image `ghcr.io/nvanderploeg/sagas`, with the app
bound to `127.0.0.1:${SAGAS_PORT:-3290}` behind a TLS reverse proxy. The app container is read-only,
drops every capability and keeps nothing on disk; `/tmp` is a 1 GiB tmpfs that holds an upload and its
unpacked files while an import runs.

```sh
docker compose --env-file .env -f deploy/compose.yaml up -d
```

Set `POSTGRES_PASSWORD`, `ADMIN_EMAILS`, `FIREBASE_WEB_API_KEY` and `FIREBASE_SERVICE_ACCOUNT_PATH`
in `.env`.

## Sign-in with Firebase

People sign in with Firebase Authentication (project `runestone-d3a35`): Google, or a link sent by
email. The browser signs in, the server verifies the ID token with the Firebase Admin SDK and keeps
a Firebase session cookie. Enable the Google and Email link sign-in methods in the Firebase console,
and add the instance's domain under Authentication, Settings, Authorized domains.

| Variable                        | Meaning                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `FIREBASE_SERVICE_ACCOUNT_FILE` | Path, inside the container, to the service account JSON. Compose mounts it read-only.                                |
| `FIREBASE_SERVICE_ACCOUNT`      | The service account JSON itself, instead of the file.                                                                |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Compose only: the host path of the JSON, mounted at `FIREBASE_SERVICE_ACCOUNT_FILE`.                                 |
| `FIREBASE_WEB_API_KEY`          | The web app's public API key, from the Firebase console's project settings.                                          |
| `FIREBASE_AUTH_DOMAIN`          | Defaults to `<project id>.firebaseapp.com`.                                                                          |
| `FIREBASE_PROJECT_ID`           | Defaults to `runestone-d3a35`.                                                                                       |
| `AUTH_COOKIE_DOMAIN`            | Domain of the shared `runestone_session` cookie, such as `.nanzero.com`. Unset gives a host-only cookie (local dev). |
| `ADMIN_EMAILS`                  | Comma-separated emails. A User who signs in with one of them is an Admin.                                            |

sagas, chronicle and beryl share one session cookie, `runestone_session`, so signing in to one signs
in to all. Set the same `AUTH_COOKIE_DOMAIN` in each, and add every parent domain it covers
(`nanzero.com`, `merc.camp`) to Authentication, Settings, Authorized domains. Each app creates its
own User on the first verified request that carries the cookie.

Keep the service account JSON out of the repository and the image; make it readable by the
container's user (`chmod 440`, group 1000).

Anyone with a Firebase account whose email is verified can sign in and becomes a human User. A first
sign-in links to the User that already holds that email (an Admin sets it on `/admin`), otherwise it
creates a new User. Each User may create `realm_limit` Realms (default 1); an Admin changes it on
`/admin`.

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
