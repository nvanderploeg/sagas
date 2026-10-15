# workload

A Jira-like ticket tracker. Work in progress: the web app is a placeholder.

## Layout

- `apps/web`: SvelteKit app (Svelte 5, Tailwind, adapter-node).
- `packages/`: shared workspace packages, none yet.

## Run locally

Needs Node.js 22+ and pnpm 11 (`corepack enable`).

```sh
pnpm install
pnpm --filter web dev
```

Open <http://localhost:5173>. The default database path is `/data/workload.db`, which is for the
container; export `DATABASE_PATH` (see `.env.example`) to point at a writable file locally.

## Run in Docker

The SQLite database lives outside the container in `./data`, bind-mounted to `/data`. The
entrypoint hands `/data` to the `node` user and runs the app as `node`, never as root.

```sh
docker-compose up -d --build
```

Open <http://localhost:3290>, or the host's LAN address on the same port. Set `WORKLOAD_PORT` in
`.env` to change the port.

The app serves plain http and takes each request's origin from its `Host` header. Behind a TLS
reverse proxy, have the proxy send `X-Forwarded-Proto` and `X-Forwarded-Host`; the session cookie
is `Secure` exactly when the forwarded protocol is https. `WORKLOAD_PROTOCOL_HEADER` and
`WORKLOAD_HOST_HEADER` name those headers; set one empty to ignore it (see `.env.example`).

## Scripts

- `pnpm build`: build every workspace.
- `pnpm check`: sync SvelteKit types and run `svelte-check`.
- `pnpm lint`: Prettier check and ESLint.
- `pnpm format`: Prettier write.
