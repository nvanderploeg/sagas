# Agent layer

What sagas holds for agents rather than people, and how a Survey scores Labours with it. Vocabulary is in `CONTEXT.md`; where the two disagree, `CONTEXT.md` wins.

## Decisions

- **Authority**: any User may set, change or clear anything in the agent layer, whoever set it before. Each value keeps who set it and when, for the Advanced view.
- **Visibility**: people see the agent layer only in the Advanced view. Its writes record no Events and leave a Labour's `updatedAt` alone, so a board never reacts to them. Clients read it when they need it.
- **Variety**: a Survey's order is a sample at a temperature; temperature 0 sorts by Score.
- **Embeddings** run in the server: `Xenova/bge-small-en-v1.5`, 8-bit, 384 dimensions, on `@huggingface/transformers` and `onnxruntime-node`. The model ships in the image; the server never downloads one. Without the model files the server still starts, logs one warning and keeps no vectors, so every Survey counts `similarity` as missing.
- **Image**: `node:22-bookworm-slim`, since `onnxruntime-node` ships glibc binaries only. The build drops the runtime's GPU providers and every other platform's binaries.
- **Retention**: Surveys and their Outcomes for `SURVEY_RETENTION_DAYS` (30 by default). A Pulse is deleted once its weight falls below 1% of its amount; one without a half-life stays.

## Limits

| What                         | Limit                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Attributes per Realm         | 32                                                                                                                                     |
| Members per `tags` Attribute | 64                                                                                                                                     |
| `scale` range                | Integers, `min < max`, `max − min ≤ 100`                                                                                               |
| `text` value                 | `spec.max` characters: 2,000 by default, at most 20,000                                                                                |
| Rubric                       | 4,000 characters; a member's 1,000                                                                                                     |
| Realm notes                  | 4,000 characters                                                                                                                       |
| Brief                        | 400 characters                                                                                                                         |
| References per Labour        | 20, each `href` 500 characters                                                                                                         |
| Link note                    | 500 characters                                                                                                                         |
| Skill level                  | 1–5                                                                                                                                    |
| Needed Skills per Labour     | 8                                                                                                                                      |
| Pulse                        | Amount in (0, 10]; mood in [−1, 1]; half-life in (0, 365] days or none; note 1,000 characters; evidence 10 items; `ref` 200 characters |
| Survey                       | 1–64 weights, each in [−10, 10]; query 500 characters; limit 1–50 (15); temperature 0–2 (0.3)                                          |
| Batch writes                 | 50 items                                                                                                                               |

Attribute, member and Skill keys take the State key format: lowercase letters, digits and hyphens, starting with a letter, at most 32 characters. `rank`, `priority` and the built-in feature names are reserved: no Attribute takes them.

## Data

The tables, their columns and constraints, the JSON shapes and the derived structures are in `docs/agent-layer-data.md`.

Besides its Attributes, a Realm holds three settings for agents: `notes`, Markdown on how to work the Realm (who feeds its Sentiment, how to judge its Attributes); `half_life_days`, its Pulses' default half-life; and `loudness`.

## Values

| Kind    | `spec`                                        | Value                                          | As a feature                         |
| ------- | --------------------------------------------- | ---------------------------------------------- | ------------------------------------ |
| `scale` | `{ min, max }`                                | An integer in range                            | `(value − min) / (max − min)`        |
| `tags`  | `{ members: [{ key, label, rubric }], max? }` | Member keys, sorted, no repeats, at most `max` | `attr:member` is 1 when held, else 0 |
| `text`  | `{ max? }`                                    | A string                                       | None; searched only                  |

- Setting a value to `null` clears it. A value must be valid for its Attribute when written.
- Setting a value always rewrites its `set_by` and `set_at`, even when the value is unchanged, so re-confirming a value clears its staleness.
- A value set before its Attribute's `revised_at` is stale.
- Narrowing a `scale` range clamps its values. Removing a member takes it out of every value; a value left empty is cleared. Neither moves a value's `set_by` or `set_at`.
- Lowering a `tags` or `text` max is refused while a value exceeds it.
- Deleting an Attribute or a member unfiles its Sentiment Pulses, which keep their `raw_key`, and deletes its Affinity Pulses.
- Moving a Labour to another Realm keeps each value whose key names an Attribute of the same kind there, if the value is valid there once `tags` drop the members that don't exist there. A `tags` or `text` value over the new max is deleted. A kept value keeps its `set_by` and `set_at`. Every other value is deleted.

## Appraisals

- The content an Appraisal reads is the Labour's title, description and Labels, and its Comments' bodies in order. `content_hash` is the SHA-256 of that, built as the data spec's Hashes say.
- A Labour without an Appraisal is unappraised. One whose content no longer matches its `content_hash` is stale.
- `get_appraisal` returns the Labour's current `content_hash`. An agent takes it before reading the Labour, and passes it back as `stamp`.
- An `appraise` item with `stamp` is stamped only when that hash still matches the content. On a mismatch its other writes still land, it stays unstamped and comes back with `stamped: false`, so it stays listed. An item without `stamp` writes without stamping.
- `list_unappraised` gives each Labour's reason: `unappraised`, newest first; then `content`, a stale Appraisal; then `values`, values set before their Attribute's `revised_at`.

An `appraise` item writes only what it names:

| Field    | Shape                                    | Effect                                                                 |
| -------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| `brief`  | string                                   | Replaces the Brief; `''` clears it                                     |
| `refs`   | `{ href, label? }[]`                     | Replaces the References; `[]` clears them                              |
| `values` | `{ key: value \| null }`                 | Sets or clears each named value; others stay                           |
| `needs`  | `{ skill: level \| null }`               | Sets or clears each named Skill; others stay                           |
| `links`  | `{ type, to \| from, note?, remove? }[]` | Adds, re-notes or (with `remove: true`) removes each Link; others stay |
| `stamp`  | string                                   | The `content_hash` the agent read; see above                           |

A Link names its other end with `to` when the appraised Labour comes first, and `from` when it comes second, so "blocked by SPIRE-12" is `{ type: "blocks", from: "SPIRE-12" }`. `relates` takes either.

## Links

- `evidence`: the first Labour supports the second, as a report supports a design.
- `blocks`: the second can't go ahead until the first is Closed. `blocks` Links never form a cycle.
- `relates`: either way round; stored once, lower id first.
- `duplicates`: the first repeats the second, which is canonical.

A Link may cross Realms.

## Mentions

- A Mention is a Labour key in any case, an Alias included, or an `@username`, in a Labour's description or a Comment. Unknown keys and names, and a Labour mentioning itself, are skipped.
- A write that changes a description or a Comment refreshes that text's Mentions in the same transaction. A target still present keeps its `first_seen_at` and `author_id`.
- `author_id` is the Comment's author, or the User whose write put the Mention into the description.
- A rebuild keeps every row whose text and target survive. A row new to a rebuild takes `first_seen_at` from its Comment's `createdAt`, or its Labour's `createdAt` for a description, and `author_id` from the Comment's author, or the Labour's Owner.

## Sentiment and Affinity

A Pulse's key is a `scale` Attribute (`impact`) or a `tags` member (`topic:boss-hp`). A Realm's Pulse whose key that Realm lacks is kept unfiled, and filing it gives it an existing key. Evidence items are URLs (`{ href, label? }`) or Labours (`{ labour }`, kept by id); one naming a deleted Labour is left out wherever Pulses are shown.

Only `report_outcomes` posts Affinity Pulses, each under a key of its Labour's Realm, so every Affinity key comes with its Realm.

A Pulse may carry a `ref`: its feeder's own id for what it saw, such as a message id or a Labour key. An author's second Pulse with the same `ref` and key is skipped, so a feeder can rescan its source without counting anything twice.

At a given moment, for each key `k` of a Realm (Sentiment) or a User (Affinity):

- A Pulse weighs `amount × 2^(−age / half-life)`, or its `amount` when it has no half-life. Its half-life defaults to the Realm's `half_life_days`, or 30 days in an Affinity.
- `volume_k` is the sum of its Pulses' weights, and `mood_k` their weighted mean mood.
- `v_k = volume_k / (volume_k + loudness)`, from 0 when silent towards 1. `loudness` is the Realm's setting, 5 by default, and 5 in every Affinity.

Features of a Labour, over each key `k` it holds a value for, with `x_k` that value as a feature:

- `sentiment = 1 − Π (1 − v_k · x_k)`
- `pain = 1 − Π (1 − v_k · max(0, −mood_k) · x_k)`
- `delight = 1 − Π (1 − v_k · max(0, mood_k) · x_k)`
- `affinity = delight − pain`, both taken over the Survey's User's Affinity, so from −1 to 1.

## Surveys

### Request

| Argument       | Meaning                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `realm?`       | A Realm or a list of them; every Realm by default                                                                                                                  |
| `for?`         | The User it is for; you by default. `skill_fit`, `pulled_in` and `affinity` read this User                                                                         |
| `query?`       | Text for `similarity` and `keywords`                                                                                                                               |
| `weights`      | `{ key: weight }`                                                                                                                                                  |
| `filter?`      | `include_closed` (`true` or `{ within_days }`), `assignee` (usernames, and `null` for unassigned), `has` (`attr:member`s all held), `labels`, `quest`, `unblocked` |
| `temperature?` | How far the order may stray from the Scores                                                                                                                        |
| `limit?`       | How many results to return                                                                                                                                         |
| `show?`        | Attribute keys whose values each result carries                                                                                                                    |

- Candidates are open Labours. `include_closed: true` adds every Closed one; `include_closed: { within_days }` adds those whose `updatedAt` falls within that many days.
- `unblocked` drops every Labour an open Labour `blocks`.
- `similarity` and `keywords` weights without a `query` come back in `ignored`.
- `keywords` turns `query` into an FTS5 match: it splits the query into runs of letters and digits, double-quotes each, and joins them with `OR`. A query with no such run scores no Labour.

### Weights

A weight key is a `scale` Attribute's key, a `tags` member as `attr:member`, or a built-in feature. A weight applies in every surveyed Realm with that key; keys that match nothing come back in `ignored`.

| Feature                        | Value                                                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `similarity`                   | `max(0, (cosine − floor) / (1 − floor))` between the query's vector and the Labour's; the floor is where unrelated text lands, 0.45 for bge-small. Needs `query` |
| `keywords`                     | Full-text relevance to `query` over title, Brief, description, Comments and `text` values, as a share of the best candidate's. Needs `query`                     |
| `sentiment`, `pain`, `delight` | See Sentiment and Affinity                                                                                                                                       |
| `affinity`                     | See Sentiment and Affinity; −1 to 1                                                                                                                              |
| `skill_fit`                    | Mean over the Labour's needed Skills of `min(1, held level / needed level)`; a Skill the User lacks counts 0                                                     |
| `mentions`                     | `1 − 2^(−s)`, where `s` sums `2^(−days old / 7)` over Mentions of the Labour in other Labours' text                                                              |
| `pulled_in`                    | As `mentions`, over Mentions of the Survey's User in the Labour's description and Comments                                                                       |
| `evidence`                     | `n / (n + 2)`, `n` being the Labours with an `evidence` Link to it                                                                                               |
| `unblocks`                     | `n / (n + 2)`, `n` being the open Labours it `blocks`                                                                                                            |
| `quest_finish`                 | The highest `(closed + 1) / total` among its Quests; 0 in none, or when Closed                                                                                   |
| `column`                       | 1 at the top of its State's column, 0 at the bottom                                                                                                              |
| `age`                          | `d / (d + 30)`, `d` being days since it was created                                                                                                              |
| `activity`                     | `2^(−d / 7)`, `d` being days since its `updatedAt` or its newest Comment, whichever is later                                                                     |

A feature without data for a Labour takes 0.5 and counts in `coverage.missing`. That covers an unset `scale` or `tags` Attribute, `skill_fit` when the Labour needs no Skills or the User holds none, and `similarity` without a current vector. `sentiment`, `pain`, `delight` and `affinity` read only values that are set.

### Order

- `score = Σ weight × feature` over the weights given.
- At temperature 0, results run highest Score first. Above 0, they run by `score + temperature × σ × g`, where `σ` is the standard deviation of the candidates' Scores and `g` is standard Gumbel noise drawn per Labour. Results show the Score itself.
- Ties go in board order: Realm, State position, Rank.

### Result

```ts
{
	survey: number;
	results: {
		key: string;
		path: string;
		title: string;
		realm: string;
		state: string; // key
		assignee: string | null;
		brief: string;
		score: number;
		contributions: Record<string, number>; // weight × feature, the five largest by size
		values?: Record<string, unknown>; // from `show`
	}[];
	sentiment: {
		realm: string;
		key: string;
		volume: number;
		mood: number;
		pulses: {
			id: number;
			note: string;
			evidence: ({ href: string; label?: string } | { labour: string })[]; // a Labour by its current key; deleted ones left out
			author: string;
			createdAt: string;
		}[]; // the two heaviest
	}[]; // the keys behind the results' sentiment, pain and delight
	coverage: {
		candidates: number;
		unappraised: number;
		stale: number;
		unembedded: number;
		missing: Record<string, number>;
	};
	ignored: string[];
}
```

Every Survey is stored with its request and results.

## Outcomes

- An Outcome names a Labour among its Survey's results. Reporting the same verdict twice changes nothing; `picked` and then `done` are two Outcomes.
- Each new Outcome posts one Affinity Pulse to the Survey's User for every key the Labour holds a non-zero value for:
  - **Amount:** `base × x_k`, where `base` is 1 for `picked`, 2 for `done` and 0.5 for `skipped`.
  - **Mood:** +1 for `picked` or `done`, −1 for `skipped`.
  - **Half-life:** the Affinity half-life.
  - **Note:** names the verdict, the Labour and the Survey.

## Derived data

- **Search**: every write that changes a Labour's title, description, Comments, Brief or `text` values refreshes its `labour_text` row in the same transaction.
- **Vectors**: a Labour's embedding input is its title, Brief and description, cut to the model's 512 tokens. Queries take the model's search prefix.
- **Embedding queue:** after a commit, a Labour without a vector for its current input and model joins a queue, which one worker drains. At startup every such Labour joins it. A write never waits for a vector, and a Survey never waits for the queue.
- **Pruning** runs with the Event pruner.

## The local helper

A stdio MCP server, `packages/mcp`, that runs beside the agent:

- It passes the sagas tools through.
- It polls and caches what an agent needs before it asks: each Realm's Attributes, its Sentiment, and the Skills. The cache lives under `${XDG_CONFIG_HOME:-~/.config}/sagas/`.
- Everything it caches is one call away on `/mcp`, so no tool depends on it.

Its polling rests on two reads:

- `get_attributes` returns the Realm's notes, settings and Attributes, each Attribute with how many Labours hold each value, so an agent can score in line with what is already set. With `since` set to the cached version it answers `{ version }` alone when nothing changed. The version rises when values change too, so the counts stay current.
- `get_sentiment` returns a snapshot with `asOf`. The helper refreshes it on a timer.

`get_sentiment` answers:

```ts
{
	asOf: string;
	keys: {
		realm: string;
		key: string; // `attr` or `attr:member`
		volume: number;
		mood: number;
		v: number;
		pulses: {
			id: number;
			note: string;
			evidence: ({ href: string; label?: string } | { labour: string })[];
			author: string;
			createdAt: string;
			weight: number;
		}[]; // heaviest first, `limit` of them (3)
	}[];
	unfiled: { raw_key: string; volume: number; count: number; newest: { id: number; note: string } }[]; // for a Realm; [] for a User
}
```

`pulse` answers `{ pulses: { index, status, id? }[] }`, one per item in order. `status` is `filed`, `unfiled` or `skipped` (a repeated `ref`), and `id` names the new Pulse.

## Tools

A draft. Each tool's final inputs go into `docs/mcp.md` when it is built.

| Tool               | Input                                                                            | Output                                                 |
| ------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `get_attributes`   | `realm, since?`                                                                  | `{ version, notes?, settings?, attributes? }`          |
| `define_attribute` | `realm, key, kind, label, rubric, spec, index?`                                  | `{ version, attribute }`                               |
| `delete_attribute` | `realm, key`                                                                     | `{ version }`                                          |
| `tune_realm`       | `realm, notes?, half_life_days?, loudness?`                                      | `{ version, notes, settings }`                         |
| `appraise`         | `labours: [{ labour, brief?, refs?, needs?, values?, links?, stamp? }]`          | `{ appraised: [{ labour, stamped }] }`                 |
| `get_appraisal`    | `labour`                                                                         | The Labour's whole agent layer, and `content_hash`     |
| `list_unappraised` | `realm?, limit?, offset?`                                                        | `{ labours: [{ labour, reason }], total, nextOffset }` |
| `pulse`            | `realm, pulses: [{ key, amount, mood, note, evidence?, half_life_days?, ref? }]` | `{ pulses: [{ index, status, id? }] }`                 |
| `get_sentiment`    | `realm \| user, limit?`                                                          | `{ asOf, keys, unfiled }`                              |
| `file_pulses`      | `realm, raw_key, key`                                                            | `{ filed }`                                            |
| `delete_pulse`     | `pulse`                                                                          | `{ deleted }`                                          |
| `define_skill`     | `key, label, rubric`                                                             | `{ skill }`                                            |
| `list_skills`      |                                                                                  | `{ skills }`                                           |
| `set_skills`       | `user, skills: { key: level \| null }`                                           | `{ user, skills }`                                     |
| `survey`           | See Surveys                                                                      | See Surveys                                            |
| `report_outcomes`  | `survey, outcomes: [{ labour, verdict }]`                                        | `{ recorded }`                                         |
