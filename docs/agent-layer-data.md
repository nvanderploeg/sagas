# Agent layer data

The storage behind `docs/agent-layer.md`: every table, column, constraint and index, the JSON in each JSON column, and the structures sagas derives from the rest. `apps/web/src/lib/server/db/schema.ts` implements it; change both together.

## Conventions

- Types are SQLite's: `integer`, `real`, `text`, `blob`. A `timestamp` is an `integer` of Unix milliseconds. A `json` column is `text` holding JSON, checked with `json_valid`.
- `id` is `integer PRIMARY KEY AUTOINCREMENT`.
- A key column takes the State key format (`STATE_KEY` in `domain/validate.ts`): lowercase letters, digits and hyphens, starting with a letter, 1–32 characters. A `CHECK` holds it, in the `GLOB` style of `realms_key_format`.
- `set_by` and `set_at` record the User whose write last set the row, and when.
- A foreign key to `labours`, `realms`, `attributes`, `skills`, `comments` or `surveys` is `ON DELETE CASCADE`. One to `users` has no delete rule: Users are never deleted.
- The agent layer adds tables and changes none, apart from one index on `labours`: `labours_realm_id_uq (realm_id, id)`, which the composite foreign key on `labour_attributes` needs.

## Tables

### `realm_agent`

A Realm's agent settings. A Realm without a row reads as version 0 with the defaults.

| Column           | Type      | Rules                                                                                                 |
| ---------------- | --------- | ----------------------------------------------------------------------------------------------------- |
| `realm_id`       | integer   | Primary key; → `realms`                                                                               |
| `version`        | integer   | ≥ 1. Rises by 1 with every transaction that changes the Realm's Attributes, values, notes or settings |
| `notes`          | text      | Markdown for agents, ≤ 4,000 characters; `''` by default                                              |
| `half_life_days` | real      | > 0 and ≤ 365; 14 by default                                                                          |
| `loudness`       | real      | > 0; 5 by default                                                                                     |
| `updated_at`     | timestamp |                                                                                                       |

### `attributes`

| Column       | Type      | Rules                                                                            |
| ------------ | --------- | -------------------------------------------------------------------------------- |
| `id`         | integer   |                                                                                  |
| `realm_id`   | integer   | → `realms`                                                                       |
| `key`        | text      | Key format; never changes. Not `rank`, `priority` or a built-in feature name     |
| `kind`       | text      | `scale`, `tags` or `text`; never changes                                         |
| `label`      | text      | 1–64 characters                                                                  |
| `rubric`     | text      | Markdown, 1–4,000 characters                                                     |
| `spec`       | json      | By kind; see JSON                                                                |
| `position`   | integer   | The Realm's display order, from 0; no CHECK, since reordering parks rows below 0 |
| `created_at` | timestamp |                                                                                  |
| `revised_at` | timestamp | Moves when `rubric` or `spec` changes. A value set before it is stale            |
| `updated_at` | timestamp | Moves on any change                                                              |

- `UNIQUE (realm_id, key)`, `UNIQUE (realm_id, position)`, and `UNIQUE (realm_id, id)` for the composite foreign key below.
- At most 32 per Realm, held by the domain.

### `labour_attributes`

| Column         | Type      | Rules                                                                                                    |
| -------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| `realm_id`     | integer   | The Labour's Realm                                                                                       |
| `labour_id`    | integer   |                                                                                                          |
| `attribute_id` | integer   |                                                                                                          |
| `value`        | json      | By the Attribute's kind; see JSON                                                                        |
| `set_by`       | integer   | → `users`                                                                                                |
| `set_at`       | timestamp | Rewritten by every write of the value, even an unchanged one; kept by clamping, member removal and moves |

- Primary key `(labour_id, attribute_id)`.
- `(realm_id, labour_id)` → `labours (realm_id, id)` and `(realm_id, attribute_id)` → `attributes (realm_id, id)`, both cascading: a value always belongs to an Attribute of its own Labour's Realm.
- Index `(attribute_id)`, for rewriting one Attribute's values.
- Moving a Labour to another Realm deletes its rows before its `realm_id` changes, then writes the values it keeps under the new Realm.

### `appraisals`

| Column         | Type      | Rules                                                            |
| -------------- | --------- | ---------------------------------------------------------------- |
| `labour_id`    | integer   | Primary key; → `labours`                                         |
| `brief`        | text      | ≤ 400 characters; `''` when none                                 |
| `refs`         | json      | References; see JSON. `'[]'` when none                           |
| `set_by`       | integer   | → `users`; who last set `brief` or `refs`. Null until first set  |
| `set_at`       | timestamp | Null until `brief` or `refs` is first written                    |
| `content_hash` | text      | 64 hex characters; see Hashes. Null until an Appraisal stamps it |
| `appraised_by` | integer   | → `users`; null until stamped                                    |
| `appraised_at` | timestamp | Null until stamped                                               |

- `CHECK`: `content_hash`, `appraised_by` and `appraised_at` are all null or all set.
- A Labour is unappraised with no row or an unstamped one, and stale when its content's hash differs from `content_hash`.

### `links`

| Column    | Type      | Rules                                           |
| --------- | --------- | ----------------------------------------------- |
| `from_id` | integer   | → `labours`                                     |
| `to_id`   | integer   | → `labours`                                     |
| `type`    | text      | `evidence`, `blocks`, `relates` or `duplicates` |
| `note`    | text      | ≤ 500 characters; `''` when none                |
| `set_by`  | integer   | → `users`                                       |
| `set_at`  | timestamp |                                                 |

- Primary key `(from_id, to_id, type)`.
- `CHECK (from_id <> to_id)` and `CHECK (type <> 'relates' OR from_id < to_id)`.
- Index `(to_id, type)`, for Links into a Labour.
- `blocks` Links never form a cycle, held by the domain.

### `mentions`

| Column             | Type      | Rules                                            |
| ------------------ | --------- | ------------------------------------------------ |
| `id`               | integer   |                                                  |
| `source_labour_id` | integer   | → `labours`; the Labour whose text holds it      |
| `comment_id`       | integer   | → `comments`; null when it is in the description |
| `labour_id`        | integer   | → `labours`; the Labour mentioned                |
| `user_id`          | integer   | → `users`; the User mentioned                    |
| `author_id`        | integer   | → `users`; who wrote it                          |
| `first_seen_at`    | timestamp |                                                  |

- `CHECK`: exactly one of `labour_id` and `user_id` is set, and `labour_id` is never `source_labour_id`.
- A unique index on `(source_labour_id, comment_id, labour_id, user_id)` that treats null as 0: one row per text and target.
- Indexes `(labour_id, first_seen_at)` and `(user_id, first_seen_at)`.

### `skills`

| Column       | Type      | Rules                              |
| ------------ | --------- | ---------------------------------- |
| `id`         | integer   |                                    |
| `key`        | text      | Key format; unique; never changes  |
| `label`      | text      | 1–64 characters                    |
| `rubric`     | text      | ≤ 4,000 characters; `''` when none |
| `created_at` | timestamp |                                    |
| `updated_at` | timestamp |                                    |

### `user_skills` and `labour_needs`

| Column                   | Type      | Rules                    |
| ------------------------ | --------- | ------------------------ |
| `user_id` or `labour_id` | integer   | → `users` or → `labours` |
| `skill_id`               | integer   | → `skills`               |
| `level`                  | integer   | 1–5                      |
| `set_by`                 | integer   | → `users`                |
| `set_at`                 | timestamp |                          |

- Primary keys `(user_id, skill_id)` and `(labour_id, skill_id)`.
- A Labour needs at most 8 Skills, held by the domain.

### `pulses`

| Column           | Type      | Rules                                                                 |
| ---------------- | --------- | --------------------------------------------------------------------- |
| `id`             | integer   |                                                                       |
| `realm_id`       | integer   | → `realms`; set for a Sentiment Pulse                                 |
| `user_id`        | integer   | → `users`; set for an Affinity Pulse                                  |
| `attribute_id`   | integer   | → `attributes`; null while unfiled                                    |
| `member`         | text      | The member key when the Attribute is `tags`; otherwise null           |
| `raw_key`        | text      | The key as given, lowercased: `attr` or `attr:member`                 |
| `amount`         | real      | > 0 and ≤ 10                                                          |
| `mood`           | real      | −1 to 1                                                               |
| `half_life_days` | real      | > 0 and ≤ 365; null for a Pulse that never fades                      |
| `note`           | text      | ≤ 1,000 characters; `''` when none                                    |
| `evidence`       | json      | See JSON; `'[]'` when none                                            |
| `ref`            | text      | The feeder's own id for what it saw, ≤ 200 characters; null when none |
| `author_id`      | integer   | → `users`                                                             |
| `created_at`     | timestamp |                                                                       |

- `CHECK`: exactly one of `realm_id` and `user_id` is set.
- `CHECK (attribute_id IS NOT NULL OR (member IS NULL AND realm_id IS NOT NULL))`: only a Sentiment Pulse is ever unfiled.
- `UNIQUE (author_id, ref, raw_key) WHERE ref IS NOT NULL`: a feeder's repeat is skipped.
- Indexes `(realm_id, attribute_id, member)`, `(user_id, attribute_id, member)`, `(realm_id, raw_key) WHERE attribute_id IS NULL` for unfiled keys, and `(created_at)` for pruning.
- Before an Attribute is deleted, the domain unfiles its Sentiment Pulses (`attribute_id` and `member` to null, `WHERE realm_id IS NOT NULL`); the cascade then deletes its Affinity Pulses. Removing a member unfiles that member's Sentiment Pulses and deletes its Affinity Pulses, by hand.
- An Affinity Pulse's `attribute_id` belongs to the Realm of the Labour whose Outcome posted it.

### `surveys`

| Column       | Type      | Rules                                           |
| ------------ | --------- | ----------------------------------------------- |
| `id`         | integer   |                                                 |
| `actor_id`   | integer   | → `users`; who ran it                           |
| `for_id`     | integer   | → `users`; whom it was for                      |
| `request`    | json      | The request as validated, its references as ids |
| `results`    | json      | See JSON                                        |
| `created_at` | timestamp | Indexed, for pruning                            |

### `outcomes`

| Column       | Type      | Rules                         |
| ------------ | --------- | ----------------------------- |
| `survey_id`  | integer   | → `surveys`                   |
| `labour_id`  | integer   | → `labours`                   |
| `verdict`    | text      | `picked`, `skipped` or `done` |
| `author_id`  | integer   | → `users`                     |
| `created_at` | timestamp |                               |

- Primary key `(survey_id, labour_id, verdict)`.

### `labour_vectors`

| Column        | Type      | Rules                                                                                          |
| ------------- | --------- | ---------------------------------------------------------------------------------------------- |
| `labour_id`   | integer   | Primary key; → `labours`                                                                       |
| `model`       | text      | `<id>@<revision>`, such as `Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3` |
| `vector`      | blob      | See Vectors                                                                                    |
| `input_hash`  | text      | 64 hex characters; see Hashes                                                                  |
| `embedded_at` | timestamp |                                                                                                |

A vector is current when its `model` is the server's, its blob is 1,536 bytes, and its `input_hash` equals the Labour's `labour_inputs.input_hash`; anything else is stale. Deciding it never reads the Labour's text.

### `labour_inputs`

| Column       | Type    | Rules                                                    |
| ------------ | ------- | -------------------------------------------------------- |
| `labour_id`  | integer | Primary key; → `labours`                                 |
| `input_hash` | text    | The hash of the embedding input as it stands; see Hashes |

Derived. Every write that changes a Labour's title, description or Brief rewrites its row in the same transaction; the embedding worker rewrites it from the text it embeds.

### `derived_builds`

| Column     | Type      | Rules                                                        |
| ---------- | --------- | ------------------------------------------------------------ |
| `name`     | text      | Primary key: `labour_text`, `mentions` or `embedding_inputs` |
| `version`  | integer   | The version of the build rules the stored data follows       |
| `built_at` | timestamp |                                                              |

At startup, before the server takes requests, a derived structure whose stored version is behind the code's is rebuilt in one transaction. `labour_text` and `embedding_inputs` (the rows of `labour_inputs`) are rebuilt whole. `mentions` keeps every row whose text and target survive; the contract's Mentions section says how a new row is seeded.

### `labour_text`

```sql
CREATE VIRTUAL TABLE labour_text USING fts5(
	title, brief, description, comments, notes,
	tokenize = 'porter unicode61'
);
```

- The rowid is the Labour's id. `comments` holds the Labour's Comment bodies in order, and `notes` its `text` values, each joined by blank lines.
- FTS5 tables take no foreign keys. Deleting a Labour deletes its row, and deleting a Realm deletes its Labours' rows, in the same transaction.
- `keywords` ranks with `bm25(labour_text, 4, 3, 1, 1, 2)`: title, Brief, description, Comments, notes. Its MATCH expression is built from the query as the contract's Surveys section says; raw query text never reaches MATCH.
- Drizzle cannot declare a virtual table, so a custom migration creates it and queries reach it through `sql`.

## JSON

`attributes.spec`, by kind:

```ts
type ScaleSpec = { min: number; max: number }; // integers; min < max; max − min ≤ 100
type TagsSpec = {
	members: { key: string; label: string; rubric: string }[]; // 1–64 in display order, keys unique
	max: number | null; // how many members a Labour may hold; null for no limit
};
type TextSpec = { max: number }; // 1–20,000; 2,000 by default
```

`labour_attributes.value`, by the Attribute's kind:

- `scale`: an integer within the spec.
- `tags`: 1 to `max` member keys, sorted, no repeats.
- `text`: a string of 1 to `max` characters.

The rest:

```ts
type Reference = { href: string; label: string | null }; // appraisals.refs; href ≤ 500, label ≤ 120
type Evidence = { href: string; label: string | null } | { labour: number }; // pulses.evidence; a Labour by id, possibly deleted since
type Results = { labour: number; score: number }[]; // surveys.results, in the order returned
```

## Hashes

- `appraisals.content_hash`: the SHA-256 hex of `JSON.stringify({ title, description, labels, comments })`, built with the keys in that order, `labels` as stored, and `comments` the bodies in id order.
- `labour_vectors.input_hash` and `labour_inputs.input_hash`: the SHA-256 hex of the embedding input, the title, Brief and description, each trimmed, empty ones dropped, joined by blank lines.

## Vectors

`labour_vectors.vector` is the model's output as little-endian float32, scaled to length 1, so a cosine is a dot product. For bge-small that is 384 values in 1,536 bytes.

## Retention

The agent layer's pruner runs on the Event pruner's schedule and deletes:

- Surveys created more than `SURVEY_RETENTION_DAYS` ago, with their Outcomes.
- Pulses with a half-life whose weight has fallen below 1% of their amount: those created more than `half_life_days × log2(100)`, about 6.64 half-lives, ago.

## Migrations

- `pnpm --filter web db:generate` produces every table above except `labour_text`, which comes from a custom migration (`drizzle-kit generate --custom`).
- Each step that changes the schema lands alone: its branch rebases on `main` and regenerates its migration before merging. Never hand-merge `drizzle/meta`; the migrator skips a migration older than the newest one applied.
- No migration fills derived data. `derived_builds` starts empty, so the first start builds `labour_text`, `mentions` and `embedding_inputs` whole, and the embedding queue takes every Labour.
