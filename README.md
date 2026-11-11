# sagas

A Jira-like labour tracker. Work in progress: the web app is a placeholder.

## Layout

- `apps/web`: SvelteKit app (Svelte 5, Tailwind, adapter-node).
- `packages/client`: `@sagas/client`, an MCP client for `/mcp` that never throws, and the cache files.
- `packages/mcp`: `@sagas/mcp`, `sagas-mcp`, the local helper an agent connects to over stdio.

## Run locally


Needs Node.js 22+ and pnpm 11 (`corepack enable`).

```sh
pnpm install
pnpm --filter web dev
```

Open <http://localhost:5173>. sagas needs a PostgreSQL 16 database; export `DATABASE_URL` (see
`.env.example`) to point at one. Migrations run when the server starts.

Tests need a database whose name ends in `_test`; they clone a template database per test:

```sh
docker run -d --name sagas-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=sagas_test -p 5432:5432 postgres:16
export DATABASE_URL=postgres://postgres:pw@127.0.0.1:5432/sagas_test
pnpm test && pnpm e2e
```

## Run in Docker

`compose.yaml` starts PostgreSQL 16 and the app. The app keeps nothing on disk: all data is in the
database, so the container runs read-only as `1000:1000` with no volume.

```sh
docker-compose up -d --build
```

Open <http://localhost:3290>, or the host's LAN address on the same port. Set `SAGAS_PORT` in
`.env` to change the port.

The app serves plain http and takes each request's origin from its `Host` header. Behind a TLS
reverse proxy, have the proxy send `X-Forwarded-Proto` and `X-Forwarded-Host`; the session cookie
is `Secure` exactly when the forwarded protocol is https. `SAGAS_PROTOCOL_HEADER` and
`SAGAS_HOST_HEADER` name those headers; set one empty to ignore it (see `.env.example`).

## Production and a shared database

`deploy/compose.yaml` is the hardened stack (read-only root, no capabilities, `/tmp` on tmpfs).
Point `DATABASE_URL` at an external server for a database over the internet:

```
DATABASE_URL=postgres://user:pw@host:5432/sagas?sslmode=verify-full
```

- `pg` 8.23 reads `sslmode=require`, `prefer` and `verify-ca` as full verification and `no-verify`
  as none; add `uselibpqcompat=true` for libpq's meanings. A private CA goes in `sslrootcert=/path`.
- The password is spliced into the URL unencoded: use hex (`openssl rand -hex 24`).
- Run one app replica. The Event Stream, the Event bus, the Webhook dispatcher, the embedding queue
  and the import lock are per process.
- Migrations run at start under `pg_advisory_lock`, so pods starting together do not race.
- The embedding model ships in the image (`/app/models`); nothing else needs a volume.

## Move to another host

An Admin opens `/admin` for instance stats (version, database size, row counts, applied
migrations), **Export** and **Import**. The contract is `docs/data-bundle.md`.

1. On the old host, choose Download export.
2. On the new host, start sagas with the same `WEBHOOK_KEY` (it decrypts Webhook secrets), complete
   `ADMIN_EMAILS` naming you, sign in and open `/admin`.
3. Choose the bundle, type `REPLACE ALL DATA`, and press Replace all data. Import replaces
   everything in one transaction: Users, Realms, Labours, Scrolls, tokens, sessions. Sign in
   afterwards as a User from the bundle. Nothing is kept of what it replaced; export first.

A bundle from the SQLite build imports the same way. `SAGAS_IMPORT_MAX_BYTES` (default 200 MiB) caps
the upload; deploy/README.md says what raising it costs. The browser sends the bundle in 256 KiB chunks, so the default `BODY_SIZE_LIMIT` of
adapter-node needs no change. A reverse proxy must allow request bodies of at least that chunk size
on `/admin/import`.

`pnpm --filter web exec node scripts/verify-legacy-import.mjs <bundle.zip>` imports a bundle into a
throwaway database and checks counts, keys, search and sequences.

## Embedding model

The embedding model (`Xenova/bge-small-en-v1.5`, 8-bit) ships in the image at `/app/models`, fetched
at build time. The server never downloads a model. For local development, run
`pnpm --filter web models:fetch` to put it in `apps/web/models`, or set `EMBEDDING_MODEL_DIR` (see
`.env.example`) to put it elsewhere.

## Connect an agent over MCP

sagas serves an MCP server at `/mcp` (Streamable HTTP). It authenticates with an API token and
acts as that token's User. Create the first token on `/account` after signing in; for more,
call the `create_api_token` tool (an Admin can also make an Agent user with `create_agent_user` and
give it its own token).

With Claude Code:

```sh
claude mcp add --transport http sagas http://localhost:3290/mcp \
  --header "Authorization: Bearer <token>"
```

The tools are listed in `docs/mcp.md`.

### Connect through the local helper

`sagas-mcp` is a stdio MCP server that sits between the agent and `/mcp`. It passes every tool
and the server's instructions through, and keeps what an agent needs before it asks: each
Realm's Attributes and Sentiment, and the Skills. They are served as MCP resources
(`sagas://realm/<KEY>`, `sagas://skills`), and the `survey` tool's description carries a short
digest of them. When the server is down it keeps
answering from its cache; a tool call then returns an error result with the reason.

```sh
pnpm install && pnpm --filter @sagas/mcp... build
claude mcp add -s user sagas \
  -e SAGAS_URL=http://localhost:3290 -e SAGAS_TOKEN=<token> \
  -- node <repo>/packages/mcp/dist/index.js
```

Without `-e`, put the variables in front of the command: `-- env SAGAS_URL=… SAGAS_TOKEN=… node …`.

- `SAGAS_URL`: the server's origin, without `/mcp`. `SAGAS_TOKEN`: an API token.
- `SAGAS_POLL_MS` (default 60000) sets how often it polls Realms, Attributes and Skills, and
  `SAGAS_SENTIMENT_MS` (default 300000) how often it refreshes Sentiment. `0` turns either off;
  any other value is held to 5 seconds through 1 day.
- `SAGAS_CALL_TIMEOUT_MS` (default 120000) bounds each tool call it passes through.
- A tool call that fails on the way is reported, never sent again: the server may have run it.
- The cache is under `${XDG_CONFIG_HOME:-~/.config}/sagas/cache/<host>/`, one directory per server,
  and holds nothing the server doesn't. Delete it to start clean.

## Connect claude.ai

claude.ai connects to `/mcp` as a custom connector, signing in through the browser instead of an
API token. It needs sagas reachable over public HTTPS, with the reverse proxy sending
`X-Forwarded-Proto` and `X-Forwarded-Host` (see "Run in Docker"): the addresses sagas hands to
claude.ai come from them.

1. On a Team or Enterprise plan, an owner first adds the connector under Organization settings →
   Connectors.
2. In claude.ai, open Settings → Connectors → Add custom connector and enter
   `https://<host>/mcp`. Leave client ID and secret empty; claude.ai registers itself.
3. A popup opens sagas. Sign in if needed, check the client name and the host the connection
   returns to, and choose Allow.

The connector acts as you, with full access to everything you can do. Its access token lasts an
hour and renews for 30 days of use; after 30 days unused, connect again.

To disconnect, revoke the connector's token on your Account page, or call `revoke_api_token`. That
ends the connection, and claude.ai must reconnect. Only claude.ai and claude.com callback URLs
(`https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`) can
register; nothing else can connect this way. The endpoints are in `docs/mcp.md`.

## Scripts

- `pnpm build`: build every workspace.
- `pnpm check`: sync SvelteKit types and run `svelte-check`.
- `pnpm e2e`: build the app and run the Playwright suite against it (first run: `pnpm exec playwright install chromium`).
- `pnpm lint`: Prettier check and ESLint.
- `pnpm format`: Prettier write.
