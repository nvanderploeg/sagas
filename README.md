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

The SQLite database lives outside the container in `./data`, bind-mounted to `/data`. The container
runs as the `node` user (uid 1000), so create the directory yourself before the first start:

```sh
mkdir -p data
docker compose up --build
```

Open <http://localhost:3290>. Set `WORKLOAD_PORT` or `WORKLOAD_ORIGIN` in `.env` to change them.

## Scripts

- `pnpm build`: build every workspace.
- `pnpm check`: sync SvelteKit types and run `svelte-check`.
- `pnpm lint`: Prettier check and ESLint.
- `pnpm format`: Prettier write.
