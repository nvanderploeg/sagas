# Agent layer: implementation plan

How the Agent layer Quest (`/quests/2`) builds `docs/agent-layer.md` (the contract) and `docs/agent-layer-data.md` (the data). Each step is one Labour in the Quest and lands green on its own.

## Scope

In: everything the contract and the data spec describe. That is Attributes and values, Appraisals, Links, Mentions and search, Surveys, Sentiment, embeddings, Skills, Outcomes and Affinity, the local helper, and the Advanced view.

Out:

- **The librarian.** Its role is in `docs/librarian.md`. This build gives it every tool it needs, but doesn't build it.
- **Feeders:** the Discord bot and the forum patroller.
- **Editing the agent layer in the UI:** the Advanced view only shows it.

## How every step lands

- Agent layer code lives in `apps/web/src/lib/server/agent/`. Its tools live in `apps/web/src/lib/server/mcp/tools/`, one file per area.
- Agent layer writes run in a plain transaction, never through `write()`. They record no Events and never change `labours.updated_at`.
- Code that reads the clock or draws randomness takes `now` and `random` as arguments, so specs can pin them.
- Each Survey feature is its own module under `agent/survey/features/`, registered in one list. That way the steps that add features don't collide.
- A step that adds tools also documents them in `docs/mcp.md`.
- Done means `pnpm lint`, `pnpm check` and `pnpm test` pass, plus `pnpm e2e` where a step says so. The existing specs and e2e pass with two edits only: a step that adds a migration raises the count in `db/client.spec.ts`, and one that adds tools extends `TOOLS` in `e2e/mcp.e2e.ts`. The board behaves exactly as before.
- A step that changes the schema lands alone: before merging, its branch rebases on `main` and regenerates its migration. Never hand-merge `drizzle/meta`.

## Steps

### 0. HUMAN: review the docs (SAGA-13)

The owner reads the contract, the data spec, this plan and `docs/librarian.md`, and settles anything still open.

### 1. Attributes (SAGA-14)

- **Delivers:**
  - Tables `realm_agent`, `attributes` and `labour_attributes`, plus the `labours_realm_id_uq` index.
  - Defining, revising, reordering and deleting Attributes, with the caps and the reserved keys.
  - Checking and setting values by kind, and the value rules: `set_at` rewritten on every write, clamping, member removal, refusing a lowered max, values going stale after a revision.
  - Values following a Labour to another Realm.
  - Realm notes and settings, and the version counter, which values move too.
  - Tools `get_attributes` (value counts, `since`), `define_attribute`, `delete_attribute`, `tune_realm`.
  - The MCP server's instructions gain the agent layer's vocabulary, and `docs/events.md` says agent layer writes record no Events.
- **Touches:** `db/schema.ts`, a migration, `agent/attributes.ts`, `domain/labours.ts` (`moveLabour`), `mcp/tools/attributes.ts`, `mcp/server.ts`, `docs/mcp.md`, `docs/events.md`.
- **Proves it:** `agent/attributes.spec.ts` covers:
  - each kind's checks, the caps and the reserved keys;
  - clamping, member removal, a refused lower max, and version bumps from values as well as Attributes;
  - stale values after a revision;
  - the move rule.

  The tool round trips go in `mcp/server.spec.ts`.

- **Narrow:** `pnpm --filter web exec vitest run src/lib/server/agent/attributes.spec.ts`
- **Depends on:** nothing.

### 2. Appraisals and Links (SAGA-15)

- **Delivers:**
  - Tables `appraisals` and `links`, and content hashing.
  - `appraise`: a batch of up to 50 in one transaction, writing Briefs, References (replaced), values and Links (added or removed, either end), and stamping against the `stamp` hash.
  - `get_appraisal` with the current `content_hash`, and `list_unappraised` with its reasons and order.
  - The `blocks` cycle check, and `relates` stored lower id first.
- **Touches:** `db/schema.ts`, a migration, `agent/appraisals.ts`, `agent/links.ts`, `mcp/tools/appraisals.ts`, `docs/mcp.md`.
- **Proves it:**
  - `agent/appraisals.spec.ts`: stamping, a mismatched `stamp` leaving the Labour unstamped, stale after edits to the title, description, Labels or Comments, the reason order, and a batch rolling back whole.
  - `agent/links.spec.ts`: cycles, normalisation, cascades.
- **Narrow:** `pnpm --filter web exec vitest run src/lib/server/agent/appraisals.spec.ts src/lib/server/agent/links.spec.ts`
- **Depends on:** 1.

### 3. Search and Mentions (SAGA-16)

- **Delivers:**
  - Tables `derived_builds`, `labour_text` (a custom migration) and `mentions`.
  - Both refreshed in the same transaction as every write that changes a Labour's text: creating and updating Labours; adding, editing and deleting Comments; Briefs; `text` values, including those dropped by deleting a `text` Attribute or by moving a Labour.
  - `labour_text` rows cleared when a Labour or Realm is deleted.
  - Mention extraction: keys in any case, Aliases included, and `@username`, keeping `first_seen_at` and `author_id`.
  - Rebuilds by version at startup, keeping surviving Mentions and seeding new ones from their text's creation.
  - The `keywords` match built from words, never raw query text, and recent Mentions in `get_appraisal`.
- **Touches:** `db/schema.ts`, migrations, `agent/search.ts`, `agent/mentions.ts`, `domain/labours.ts`, `domain/comments.ts`, `domain/realms.ts`, `agent/appraisals.ts`, `agent/attributes.ts`, `hooks.server.ts` (`init`).
- **Proves it:**
  - `agent/search.spec.ts` and `agent/mentions.spec.ts`: a refresh on each kind of write, `first_seen_at` kept across edits, deletes clearing rows, a rebuild when the version moves that keeps old `first_seen_at`, and queries with hyphens, quotes and several words.
  - The existing domain specs pass unchanged.
- **Narrow:** `pnpm --filter web exec vitest run src/lib/server/agent/search.spec.ts src/lib/server/agent/mentions.spec.ts`
- **Depends on:** 2.

### 4. Survey (SAGA-17)

- **Delivers:**
  - Table `surveys`.
  - The request, checked and with its references resolved; candidates and filters, `include_closed` and `assignee: null` among them.
  - The feature registry, with every feature the earlier steps can feed: Attribute keys, `keywords`, `mentions`, `pulled_in`, `evidence`, `unblocks`, `quest_finish`, `column`, `age`, `activity`.
  - Missing data at 0.5, with coverage.
  - The Score, and the order: Gumbel noise at a temperature, ties in board order.
  - The result, storage, and pruning with `SURVEY_RETENTION_DAYS`.
  - The `survey` tool. Features that later steps add come back in `ignored` until then, as do `similarity` and `keywords` without a `query`.
- **Touches:** `db/schema.ts`, a migration, `agent/survey/`, `mcp/tools/survey.ts`, `config.ts`, `.env.example`, `hooks.server.ts` (the agent pruner beside the Event pruner), `docs/mcp.md`.
- **Proves it:** specs in `agent/survey/` covering:
  - each feature's formula on a small fixture;
  - missing data, ignored keys and every filter;
  - the order and ties at temperature 0, and a pinned sample above 0;
  - storage and pruning;
  - a Survey over 5,000 Labours finishing in under 200 ms.
- **Narrow:** `pnpm --filter web exec vitest run src/lib/server/agent/survey`
- **Depends on:** 3.

### 5. Sentiment (SAGA-18)

- **Delivers:**
  - Table `pulses`.
  - `pulse` for a Realm, reporting each Pulse's status and id.
  - `get_sentiment` for a Realm, with volume, mood, `v`, the heaviest Pulses with their ids, and the unfiled keys.
  - `file_pulses` and `delete_pulse`.
  - Decay; unfiling when an Attribute or member goes; pruning.
  - The `sentiment`, `pain` and `delight` features, and the result's `sentiment` block, leaving out evidence that names a deleted Labour.
- **Touches:** `db/schema.ts`, a migration, `agent/sentiment.ts`, `agent/attributes.ts`, `agent/survey/features/`, `mcp/tools/sentiment.ts`, `docs/mcp.md`.
- **Proves it:** `agent/sentiment.spec.ts` covers:
  - volume and mood at pinned times, and loudness;
  - `ref` repeats and filing;
  - unfiling when an Attribute or member is deleted;
  - the pruning threshold;
  - the three features.
- **Narrow:** `pnpm --filter web exec vitest run src/lib/server/agent/sentiment.spec.ts`
- **Depends on:** 4.

### 6. The image on Debian slim, with the model inside (SAGA-19)

- **Delivers:**
  - Both Dockerfile stages on `node:22-bookworm-slim`, and the `@huggingface/transformers` dependency.
  - `onnxruntime-node` cut down to the build platform's CPU library.
  - The model fetched at build time into `EMBEDDING_MODEL_DIR` (`/app/models`).
  - The entrypoint dropping root with `setpriv` instead of `su-exec`.
  - A `models:fetch` script for running locally.
  - CI building the image on pull requests too, without pushing.
  - README and `.env.example`.
- **Touches:** `Dockerfile`, `docker-entrypoint.sh`, `.github/workflows/ci.yml`, `apps/web/package.json`, `README.md`, `.env.example`, `.gitignore`.
- **Proves it:** the CI image build. Locally, the image builds and passes its health check under `--network none`, and the app runs as `node`.
- **Narrow:** `docker build -t sagas:debian . && docker run --rm --network none sagas:debian node -e "process.exit(0)"`
- **Depends on:** nothing. It runs beside the other steps.

### 7. Vectors and similarity (SAGA-20)

- **Delivers:**
  - Table `labour_vectors`.
  - The embedder: it loads from `EMBEDDING_MODEL_DIR`, never downloads, and warns and stays off without the files. It embeds documents, and queries with the search prefix.
  - The queue and its worker, fed after commits and at startup.
  - The `similarity` feature and `unembedded` coverage.
  - CI fetching the model once and caching it by model id.
- **Touches:** `db/schema.ts`, a migration, `agent/vectors/`, `agent/search.ts` (text writes also queue), `agent/survey/features/`, `config.ts`, `hooks.server.ts`, `.github/workflows/ci.yml`.
- **Proves it:**
  - Unit specs with a fake embedder: queueing, staleness by input hash and by model, the similarity floor.
  - One spec against the real model, run whenever its files are present: for "improve combat feel for boss fights", the bullet-sponge and telegraph texts outrank unrelated ones.
- **Narrow:** `pnpm --filter web exec vitest run src/lib/server/agent/vectors`
- **Depends on:** 4 and 6.

### 8. Skills (SAGA-21)

- **Delivers:**
  - Tables `skills`, `user_skills` and `labour_needs`.
  - `define_skill`, `list_skills` and `set_skills`.
  - `needs` in `appraise` and `get_appraisal`.
  - The `skill_fit` feature.
- **Touches:** `db/schema.ts`, a migration, `agent/skills.ts`, `agent/appraisals.ts`, `agent/survey/features/`, `mcp/tools/skills.ts`, `docs/mcp.md`.
- **Proves it:** `agent/skills.spec.ts` covers the caps, levels, and `skill_fit` including both missing cases.
- **Narrow:** `pnpm --filter web exec vitest run src/lib/server/agent/skills.spec.ts`
- **Depends on:** 4.

### 9. Outcomes and Affinity (SAGA-22)

- **Delivers:**
  - Table `outcomes`.
  - `report_outcomes`, which posts Affinity Pulses under keys of each Labour's Realm.
  - `get_sentiment` taking a `user`.
  - Deleting an Attribute or member deleting its Affinity Pulses.
  - The `affinity` feature.
- **Touches:** `db/schema.ts`, a migration, `agent/outcomes.ts`, `agent/sentiment.ts`, `agent/attributes.ts`, `agent/survey/features/`, `mcp/tools/survey.ts`, `mcp/tools/sentiment.ts`, `docs/mcp.md`.
- **Proves it:** `agent/outcomes.spec.ts` covers:
  - amounts by verdict and value;
  - repeats changing nothing;
  - a Labour outside the Survey refused;
  - `affinity` turning negative after skips;
  - deleting an Attribute, and removing a member, with Affinity Pulses present.
- **Narrow:** `pnpm --filter web exec vitest run src/lib/server/agent/outcomes.spec.ts`
- **Depends on:** 5.

### 10. Local helper (SAGA-23)

- **Delivers:**
  - `packages/client`: talks to `/mcp` with a token, keeps cache files under the config dir written atomically, and never throws (it warns instead).
  - `packages/mcp` (`sagas-mcp`, stdio):
    - passes every server tool through;
    - polls each Realm's `get_attributes` (with `since`) and `get_sentiment`, and `list_skills`;
    - serves the cache as one resource per Realm, puts a short digest of it in the `survey` tool's description, and tells the client when either changes.
  - A README section on connecting through the helper.
- **Touches:** `packages/client/`, `packages/mcp/`, `README.md`.
- **Proves it:** specs in both packages against a stub `/mcp`:
  - tools pass through;
  - `since` gets an unchanged answer;
  - the cache survives a restart and an unreachable server.
- **Narrow:** `pnpm --filter ./packages/mcp test`
- **Depends on:** 5 and 8.

### 11. Advanced view (SAGA-24)

- **Delivers:**
  - The switch: off by default, remembered per browser.
  - **On a Labour's page:** its agent layer. That's its Brief, References, values with who set them and when, needed Skills, Links both ways, recent Mentions, and the Appraisal stamp with staleness.
  - **On a Realm's settings page:** its notes, Attributes, Sentiment and unfiled keys.
  - **On the account page:** the User's Skills and Affinity.
  - Everything is read-only, loaded only while the switch is on, from session-authenticated JSON endpoints.
- **Touches:** `routes/api/agent/`, `server/ui/`, `components/labour/LabourPage.svelte`, `routes/r/[key]/settings/`, `routes/account/`, a new `AgentPanel` component.
- **Proves it:** `e2e/ui-advanced.e2e.ts`:
  - with the switch off, a Labour's page shows nothing new;
  - switched on, the seeded values show;
  - the switch survives a reload;
  - the board never changes.
- **Narrow:** `pnpm exec playwright test e2e/ui-advanced.e2e.ts`
- **Depends on:** 8 and 9.

### 12. Scenario specs (SAGA-25)

- **Delivers:**
  - **A fixture Realm in Stormspire's mould:** reports, designs and tasks around boss fights, UI and audio; an artist and a programmer with Skills; and Pulses from a stand-in feeder.
  - **A spec for each ask at temperature 0, checking which Labours lead and why (`contributions`):**
    - the artist's biggest win;
    - the programmer's "improve combat feel for boss fights".
  - **An MCP e2e:** define, appraise, pulse, survey, report outcomes.
- **Touches:** `agent/scenarios.spec.ts`, `e2e/agent-layer.e2e.ts`, their fixtures.
- **Proves it:** itself. The real-model variant runs whenever the model's files are present.
- **Narrow:** `pnpm --filter web exec vitest run src/lib/server/agent/scenarios.spec.ts`
- **Depends on:** 7, 8 and 9.

### 13. HUMAN: seed Stormspire and ask for real (SAGA-26)

With an agent's help, the owner:

1. defines SPIRE's notes and Attributes, the Skills, and the team's levels;
2. appraises the first Labours;
3. posts the first Pulses by hand;
4. asks both questions through the helper and judges the answers.

- **Depends on:** 10, 11 and 12.

## Order

Every step waits on step 0.

| Step | Labour  | Depends on |
| ---- | ------- | ---------- |
| 1    | SAGA-14 |            |
| 2    | SAGA-15 | 1          |
| 3    | SAGA-16 | 2          |
| 4    | SAGA-17 | 3          |
| 5    | SAGA-18 | 4          |
| 6    | SAGA-19 |            |
| 7    | SAGA-20 | 4, 6       |
| 8    | SAGA-21 | 4          |
| 9    | SAGA-22 | 5          |
| 10   | SAGA-23 | 5, 8       |
| 11   | SAGA-24 | 8, 9       |
| 12   | SAGA-25 | 7, 8, 9    |
| 13   | SAGA-26 | 10, 11, 12 |

Steps 1 to 4 run one after another: steps 1 to 3 all touch `domain/labours.ts`, and step 4 needs all three. Step 6 can start at any time. Once step 4 lands, steps 5, 7 and 8 can be built side by side, since each adds its own feature modules, but each adds a migration, so they merge one at a time, each rebased and regenerated on the last.

## Risks

- **The image move:** `better-sqlite3`, the entrypoint and the model directory all change at once, and today a broken image only shows up on `main`. Step 6 builds the image on every pull request.
- **The model in CI:** the real-model specs need its files. CI fetches them once and caches them by model id. Without them, those specs skip and everything else still runs.
- **Memory:** the model adds about 150 MB of resident memory to the server.
- **Survey cost:** scoring runs in memory over every candidate. Step 4 sets the bar at 5,000 Labours in under 200 ms on a developer machine; the timing specs give shared CI runners four times as long (`lib/server/test/budget.ts`).
- **Randomness:** specs pin `random` and `now`, so tests are repeatable even though a Survey's order isn't.

## Done

The Quest is done when the scenario specs pass in CI, and both asks put to Stormspire through the helper come back with answers the team would act on.
