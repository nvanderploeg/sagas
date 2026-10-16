# sagas

A Jira-like labour tracker. Work in progress: the web app is a placeholder.

## Layout

- `apps/web`: SvelteKit app (Svelte 5, Tailwind, adapter-node).
- `packages/`: shared workspace packages, none yet.

## Run locally

Needs Node.js 22+ and pnpm 11 (`corepack enable`).

```sh
pnpm install
pnpm --filter web dev
```

Open <http://localhost:5173>. The default database path is `/data/sagas.db`, which is for the
container; export `DATABASE_PATH` (see `.env.example`) to point at a writable file locally.

## Run in Docker

The SQLite database lives outside the container in `./data`, bind-mounted to `/data`. The
entrypoint hands `/data` to the `node` user and runs the app as `node`, never as root.

```sh
docker-compose up -d --build
```

Open <http://localhost:3290>, or the host's LAN address on the same port. Set `SAGAS_PORT` in
`.env` to change the port.

The app serves plain http and takes each request's origin from its `Host` header. Behind a TLS
reverse proxy, have the proxy send `X-Forwarded-Proto` and `X-Forwarded-Host`; the session cookie
is `Secure` exactly when the forwarded protocol is https. `SAGAS_PROTOCOL_HEADER` and
`SAGAS_HOST_HEADER` name those headers; set one empty to ignore it (see `.env.example`).

## Embedding model

The embedding model (`Xenova/bge-small-en-v1.5`, 8-bit) ships in the image at `/app/models`, fetched
at build time. The server never downloads a model. For local development, run
`pnpm --filter web models:fetch` to put it in `apps/web/models`, or set `EMBEDDING_MODEL_DIR` (see
`.env.example`) to put it elsewhere.

## Connect an agent over MCP

sagas serves an MCP server at `/mcp` (Streamable HTTP). It authenticates with an API token and
acts as that token's User. The first Admin's token is shown once, at the end of `/setup`; for more,
call the `create_api_token` tool (an Admin can also make an Agent user with `create_agent_user` and
give it its own token).

With Claude Code:

```sh
claude mcp add --transport http sagas http://localhost:3290/mcp \
  --header "Authorization: Bearer <token>"
```

The tools are listed in `docs/mcp.md`.

## Scripts

- `pnpm build`: build every workspace.
- `pnpm check`: sync SvelteKit types and run `svelte-check`.
- `pnpm e2e`: build the app and run the Playwright suite against it (first run: `pnpm exec playwright install chromium`).
- `pnpm lint`: Prettier check and ESLint.
- `pnpm format`: Prettier write.
