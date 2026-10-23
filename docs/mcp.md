# MCP

The MCP server at `/mcp`, for agents. Vocabulary is in `CONTEXT.md`; the decision is in `docs/mvp.md`.

## Connecting

- Streamable HTTP, stateless: `POST /mcp` with one JSON-RPC message, answered with `application/json`. No session id. The server declares `tools` only, without `listChanged`.
- Authenticate every request with `Authorization: Bearer <API token>`. A session cookie is not enough. Otherwise 401, with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`.
- An OAuth access token (see "OAuth") works exactly like an API token, with full access as its User; it also expires.
- Every tool acts as the token's User, and every Event its writes record names that User as `actor`.

| Request                                                    | Answer                                                                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `POST` with an `Origin` that is not this server's origin   | 403. A request without `Origin` proceeds on its token.                                                                      |
| A JSON-RPC batch (an array)                                | 400, JSON-RPC error `-32600`.                                                                                               |
| A body over `BODY_SIZE_LIMIT` (adapter-node, 512K default) | 413, JSON-RPC error `-32600`, `Request body too large: it exceeds BODY_SIZE_LIMIT`.                                         |
| Not JSON                                                   | 400, JSON-RPC error `-32700`.                                                                                               |
| `GET`                                                      | 405, `Allow: POST`. 401 first without a token.                                                                              |
| `DELETE`                                                   | 405, `Allow: POST`. 403 first, from SvelteKit's CSRF check, unless it carries a matching `Origin` or a JSON `Content-Type`. |

## OAuth

An OAuth client such as claude.ai connects to `/mcp` by authorization code with PKCE (S256). One scope, `sagas`, gives full access as the signed-in User. `<origin>` is the origin the request reached.

| Endpoint                                                                | Request                                                                                                                                                                                                                                                                                                                              | Answer                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /.well-known/oauth-protected-resource` (also with a `/mcp` suffix) |                                                                                                                                                                                                                                                                                                                                      | RFC 9728 JSON: `resource` (`<origin>/mcp`), `authorization_servers`, `scopes_supported`, `bearer_methods_supported`, `resource_name`. `cache-control: public, max-age=300`.                                                               |
| `GET /.well-known/oauth-authorization-server`                           |                                                                                                                                                                                                                                                                                                                                      | RFC 8414 JSON: `issuer`, the three endpoints below, `response_types_supported: ["code"]`, both grant types, `code_challenge_methods_supported: ["S256"]`, the three client auth methods. Same cache header.                               |
| `POST /oauth/register`                                                  | RFC 7591 JSON: `redirect_uris` (required), `client_name?` (1-100 characters; `OAuth client` when absent), `token_endpoint_auth_method?` (`none`, the default, `client_secret_post` or `client_secret_basic`). Other fields are ignored.                                                                                              | 201 with `client_id`, `client_name`, `redirect_uris`, `token_endpoint_auth_method`, `grant_types`, `response_types`, `client_id_issued_at`, and for a confidential client `client_secret` (shown once) and `client_secret_expires_at: 0`. |
| `GET /oauth/authorize`                                                  | Query: `response_type=code`, `client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method=S256`, `state?`, `resource?` (must be `<origin>/mcp`). `scope` is ignored.                                                                                                                                                        | The consent page. Signed out: 303 to `/login`, and back here after login and any forced password change.                                                                                                                                  |
| `POST /oauth/authorize`                                                 | The consent form: Allow or Deny.                                                                                                                                                                                                                                                                                                     | 303 to `redirect_uri` with `code` and `state` (Allow) or `error=access_denied` and `state` (Deny).                                                                                                                                        |
| `POST /oauth/token`                                                     | `application/x-www-form-urlencoded`. Client auth by `client_secret_basic`, by `client_id` and `client_secret` in the body, or `client_id` alone (`none`). Then `grant_type=authorization_code` with `code`, `redirect_uri`, `code_verifier`; or `grant_type=refresh_token` with `refresh_token`. `resource?` must be `<origin>/mcp`. | 200 `{ access_token, token_type: "Bearer", expires_in, refresh_token, scope }`, `cache-control: no-store`.                                                                                                                                |

- Registration accepts only these `redirect_uris`, every one of them: `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`. Anything else is `invalid_redirect_uri`. It is throttled per client address: 8 registrations in 15 minutes, then 429 `invalid_request`.
- Registration and token errors are 400 `{ error, error_description }`: `invalid_client_metadata` (not a JSON object, a bad name or auth method), `invalid_redirect_uri`, `invalid_request`, `invalid_client`, `invalid_grant`, `unsupported_grant_type`, `invalid_target` (a `resource` that is not `<origin>/mcp`). `invalid_client` is 401, with `WWW-Authenticate: Basic` when the client used Basic.
- `/oauth/authorize` with an unknown client or a `redirect_uri` not registered for it shows an error page and never redirects. Any other bad parameter redirects to `redirect_uri` with `error`, `error_description` and `state`.
- The consent page names the client, whose name the client chose itself, and the host `redirect_uri` returns to, and says the connection acts as the signed-in User with full access.
- A `code_verifier` is 43-128 characters of `A-Za-z0-9._~-`. A `code_challenge` is 43 characters of `A-Za-z0-9_-`.
- Lifetimes: a code 10 minutes, an access token 1 hour (`expires_in: 3600`), a refresh token 30 days. A refresh returns a new refresh token and a new access token for the same connection; the old refresh token and access token stop working.
- A code works once. Presenting it again, or presenting a refresh token already rotated, is `invalid_grant` and revokes the connection it belongs to.
- Revoking a connection's access token (`revoke_api_token`, or the Account page) revokes its refresh token too, and the reverse. The next request with the access token is 401; a refresh is `invalid_grant`, and the client must run the authorization again.
- `list_api_tokens` shows a connection's access token with `oauth: true`; its name is `<client name> (OAuth)`.
- CSRF: a `POST`, `PUT`, `PATCH` or `DELETE` with a form content type, or none, needs an `Origin` equal to this server's origin, on every path except `/oauth/token` and `/oauth/register`. Otherwise 403 `Cross-site <METHOD> form submissions are forbidden`.

## Arguments

| Kind      | Accepts                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Labour    | Labour key in any case, former keys (Aliases) included, or id                                                                |
| Realm     | Realm key in any case, former keys included, or id                                                                           |
| State     | State key within the tool's Realm, or id                                                                                     |
| Substate  | Substate key within its State, or id                                                                                         |
| User      | Username in any case, `"me"` for the token's User, or id                                                                     |
| Quest     | Id                                                                                                                           |
| Placement | Of a Labour in its column or in a Quest: at most one of `position: "top" \| "bottom"`, `before: <Labour>`, `after: <Labour>` |
| Index     | Of a State or Substate: `index`, 0-based                                                                                     |

- An id is a JSON number. A string is always a key or a username; a string of digits is `invalid`.
- `"me"` always means the token's User; reach a User named `me` by id.
- Unknown arguments are `invalid`, and the message names them.
- An argument shown with `?` is optional; `| null` clears.

## Results

A result has `structuredContent` and one text item: a one-line summary, a newline, then `structuredContent` as JSON. A Labour's summary shows its State and Substate keys and labels: `AM-1 [doing: Doing › review: Review] Title`.

- **Labour**: `{ id, key, path, url, title, brief, realm, state: { key, label }, substate: { key, label } | null, closed, owner, assignee, parent, labels }`. `realm` is its Realm key, `owner` and `assignee` usernames, `parent` the Parent's key, `brief` its Appraisal's Brief (`""` when none).
- **`path`** and **`url`**: the page of a Labour, Realm or Quest (`/l/AM-123`, `/r/AM`, `/quests/7`); `url` is `path` on the origin the request reached (`https://sagas.example.org/l/AM-123`).
- **LabourDetail**: Labour plus `{ description, aliases, createdAt, updatedAt, parentLabour: Labour | null, children: Labour[], quests: [{ id, name, progress }] }`.
- **Comment**: `{ id, labour, author, body, createdAt, updatedAt | null }`. `labour` is the Labour's key, `author` a username, `body` Markdown.
- **Realm**: `{ id, key, path, url, name, aliases, notes, initialState, states: [{ id, key, label, color, icon, closed, open, defaultSubstate, substates: [{ id, key, label, color, icon }] }] }`, States and Substates in order. `initialState` and `defaultSubstate` are keys; `notes` are the Realm's agent notes (`""` when none).
- **Quest**: `{ id, path, url, name, description, owner, progress: { closed, total }, labours: Labour[] }`, members in Quest order.
- **Attribute**: `{ key, kind, label, rubric, spec, position, revisedAt, held, stale, counts }`, in `position` order. `spec` is `{ min, max }` for `scale`, `{ members: [{ key, label, rubric }], max | null }` for `tags` and `{ max }` for `text`. `held` is how many Labours hold a value, `stale` how many of those were set before `revisedAt` (an ISO time), and `counts` the Labours per value: per integer for `scale`, per member (every member, 0 included) for `tags`, empty for `text`.
- **Appraisal**: `{ labour, brief, refs: [{ href, label | null }], setBy | null, setAt | null, contentHash, stamp: { contentHash, appraisedBy, appraisedAt } | null, unappraised, stale, values: [{ key, kind, value, setBy, setAt, stale }], links: Link[], needs: [{ skill, level, setBy, setAt }], mentions: [{ in, comment | null, by, firstSeenAt }] }`. `labour` is the Labour's key; `setBy` and `appraisedBy` are usernames, and `setBy` and `setAt` are null until a Brief or References are first written; `contentHash` is the hash of the Labour's title, description, Labels and Comments now, and `stamp.contentHash` the one the last stamped Appraisal read. `unappraised` means no stamp, `stale` a stamp whose hash is not `contentHash`. `values` are the Labour's Attribute values. `needs` are the Skills the Labour needs and at what level, by `skill` key; `setBy` is a username and `setAt` an ISO time. `mentions` are the 10 newest Mentions of this Labour in other Labours' descriptions and Comments, newest first: `in` is the key of the Labour holding the text, `comment` the Comment's id (null for a description), `by` the author's username and `firstSeenAt` an ISO time.
- **Link**: `{ type, from, to, note, setBy, setAt }`, `from` and `to` Labour keys, ordered by type (`evidence`, `blocks`, `relates`, `duplicates`), then `from`, then `to`. `evidence`: `from` supports `to`. `blocks`: `to` can't go ahead until `from` is Closed. `duplicates`: `from` repeats `to`. `relates` has no direction and is stored with the lower id as `from`.
- **Survey result**: `{ survey, results: [{ key, path, url, title, realm, state, assignee, brief, score, contributions, values? }], sentiment, coverage: { candidates, unappraised, stale, unembedded, missing }, ignored }`. `survey` is the stored Survey's id. `results` run in the order asked for, at most `limit`; `key` is the Labour key, `realm` and `state` keys, `assignee` a username or null, `brief` the Appraisal's Brief (`""` when none). `score` is the Labour's Score, and `contributions` the weight times feature behind its five largest terms, largest first, zeros left out. `values` is `{ key: value }` of the `show` Attributes the Labour holds, present only when `show` was given. `sentiment` lists the keys behind the `sentiment`, `pain` and `delight` weights as `[{ realm, key, volume, mood, pulses: Pulse[] }]` (`realm` a Realm key, `key` `attr` or `attr:member`), for the keys some returned Labour holds that have volume, loudest first and then by Realm and key, at most 10, each with its two heaviest Pulses; it is `[]` when none of the three is weighted. `coverage` counts the candidates before `limit`: `unappraised` never stamped, `stale` stamped but changed since, `unembedded` without a current vector (one for the Labour's present title, Brief and description), and `missing`, per applied weight key, the candidates that took 0.5 for lack of data (keys with none are left out). `ignored` lists the weight and `show` keys that matched nothing, in order.
- **Skill**: `{ key, label, rubric }`, with `holders` (how many Users hold it) when listed by `list_skills`.
- **Outcome**: `{ labour, verdict, recorded }`, `labour` the Labour's current key.
- **Pulse**: `{ id, note, evidence, author, createdAt }`, with `weight` when it is listed by `get_sentiment`. `evidence` items are `{ href, label | null }` or `{ labour }`, a Labour's current key; one naming a deleted Labour is left out. `author` is a username and `createdAt` an ISO time.
- **User**: `{ id, username, displayName, kind, isAdmin }`.

An error is a result with `isError: true`, its message as text, and `structuredContent: { error: { code, message } }`. `code` is `invalid` (bad or unknown arguments included), `not_found` (an unknown tool included), `conflict` or `forbidden`; any other failure is `internal`, with no detail. Messages name Labours by key.

## Tools

### Labours

| Tool             | Input                                                                                                                                       | Output                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `resolve`        | `labour`                                                                                                                                    | `{ labour: Labour, alias }`                                |
| `list_labours`   | `realm?, state?, substate?, owner?, assignee? \| null, closed?, open?, quest?, parent? \| null, labels?, limit? (50, max 200), offset? (0)` | `{ labours: Labour[], total, offset, nextOffset \| null }` |
| `get_labour`     | `labour`                                                                                                                                    | `{ labour: LabourDetail, links: Link[] }`                  |
| `create_labour`  | `realm, title, description?, owner? (you), assignee?, state?, substate?, parent?, labels?, placement`                                       | `{ labour: LabourDetail }`                                 |
| `update_labour`  | `labour, title?, description?, owner?, assignee? \| null, state?, substate? \| null, labels?, add_labels?, remove_labels?, placement`       | `{ labour: LabourDetail }`                                 |
| `move_labour`    | `labour, realm, state?, substate?, placement`                                                                                               | `{ labour: LabourDetail }`                                 |
| `rank_labour`    | `labour, placement` (required)                                                                                                              | `{ labour: LabourDetail }`                                 |
| `set_parent`     | `labour, parent \| null`                                                                                                                    | `{ labour: LabourDetail }`                                 |
| `delete_labour`  | `labour`                                                                                                                                    | `{ deleted: { id, key } }`                                 |
| `add_comment`    | `labour, body`                                                                                                                              | `{ comment: Comment }`                                     |
| `update_comment` | `comment, body`                                                                                                                             | `{ comment: Comment }`                                     |
| `delete_comment` | `comment`                                                                                                                                   | `{ deleted: { id, labour } }`                              |
| `list_comments`  | `labour`                                                                                                                                    | `{ comments: Comment[] }`                                  |

`closed: false` keeps every Labour not Closed; `open: true` keeps those in a State the Realm marks open. `list_labours` orders by Realm, then State order, then Rank; with `quest`, by Quest order. A State key needs `realm`; a Substate key needs `state`; `labels` keeps Labours carrying every one given. On `update_labour`, `labels` replaces the set, then `add_labels` and `remove_labels` adjust it. Comments list oldest first; only a Comment's author can change or delete it (`forbidden` otherwise); `comment` is its id.

### Realms, States and Substates

The Realm's `state` and `substate` arguments resolve within `realm`. Every write returns `{ realm: Realm }`.

| Tool                   | Input                                                                          | Output                                          |
| ---------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------- |
| `list_realms`          |                                                                                | `{ realms: [{ id, key, url, name, aliases }] }` |
| `get_realm`            | `realm`                                                                        | `{ realm: Realm }`                              |
| `create_realm`         | `name, key, initialState? { key, label, color, icon }` (default `todo`)        | `{ realm }`                                     |
| `update_realm`         | `realm, name`                                                                  | `{ realm }`                                     |
| `rename_realm_key`     | `realm, key`                                                                   | `{ realm }`                                     |
| `delete_realm`         | `realm`                                                                        | `{ deleted: { id, key } }`                      |
| `set_initial_state`    | `realm, state`                                                                 | `{ realm }`                                     |
| `create_state`         | `realm, key, label, color, icon, index?` (before Closed; last), `open?` (true) | `{ realm }`                                     |
| `update_state`         | `realm, state, label?, color?, icon?, open?, next?`                            | `{ realm }`                                     |
| `reorder_state`        | `realm, state, index`                                                          | `{ realm }`                                     |
| `delete_state`         | `realm, state`                                                                 | `{ realm }`                                     |
| `create_substate`      | `realm, state, key, label, color, icon, index?` (last)                         | `{ realm }`                                     |
| `update_substate`      | `realm, state, substate, label?, color?, icon?`                                | `{ realm }`                                     |
| `reorder_substate`     | `realm, state, substate, index`                                                | `{ realm }`                                     |
| `delete_substate`      | `realm, state, substate`                                                       | `{ realm }`                                     |
| `set_default_substate` | `realm, state, substate`                                                       | `{ realm }`                                     |

### Quests

| Tool                   | Input                                         | Output                                                                       |
| ---------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| `list_quests`          |                                               | `{ quests: [{ id, path, url, name, description, realm, owner, progress }] }` |
| `get_quest`            | `quest`                                       | `{ quest: Quest }`                                                           |
| `create_quest`         | `realm, name, description?, owner? (you)`     | `{ quest: Quest }`                                                           |
| `update_quest`         | `quest, name?, description?, owner?`          | `{ quest: Quest }`                                                           |
| `delete_quest`         | `quest`                                       | `{ deleted: { id, name } }`                                                  |
| `add_quest_labours`    | `quest, labours: Labour[] (1–100), placement` | `{ quest: Quest, added, skipped }`                                           |
| `remove_quest_labours` | `quest, labours: Labour[] (1–100)`            | `{ quest: Quest, removed, skipped }`                                         |
| `rank_quest_labour`    | `quest, labour, placement` (required)         | `{ quest: Quest }`                                                           |

`add_quest_labours` and `remove_quest_labours` are one write each, recording one `quest.labours_added` or `quest.labours_removed` that names only the Labours that changed. `added`, `removed` and `skipped` are Labour keys. A Labour already as asked is skipped, never an error, so a repeated call is safe; a Labour listed twice counts once; an unknown Labour fails the whole call. Labours are added in the order given, and never with their Children.

### Attributes

An agent layer write records no Events (`docs/agent-layer.md`). A Realm's `version` is 0 until its first change and rises by 1 with each call that changes its Attributes, values, notes or settings.

| Tool               | Input                                              | Output                                                                                     |
| ------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `get_attributes`   | `realm, since?`                                    | `{ realm, version, notes, settings: { halfLifeDays, loudness }, attributes: Attribute[] }` |
| `define_attribute` | `realm, key, kind, label?, rubric?, spec?, index?` | `{ version, attribute: Attribute }`                                                        |
| `delete_attribute` | `realm, key`                                       | `{ version, deleted: { key } }`                                                            |
| `tune_realm`       | `realm, notes?, half_life_days?, loudness?`        | `{ realm, version, notes, settings: { halfLifeDays, loudness } }`                          |

`get_attributes` with `since` equal to the current version answers `{ realm, version }` alone. `define_attribute` creates the Attribute when the Realm has none with that `key` (`label`, `rubric` and, except for `text`, `spec` are then required), and otherwise revises or moves it: what it leaves out stays, `kind` cannot change, and `index` is 0-based among the Realm's Attributes (last on create). `spec` is `{ min, max }` for `scale`, `{ members: [{ key, label, rubric? }], max? }` for `tags` and `{ max? }` for `text`. Narrowing a `scale` clamps its values, removing members takes them out of values, and lowering a `max` below a held value is `conflict`. `delete_attribute` deletes the values too.

### Appraisals and Links

An agent layer write records no Events and never changes a Labour's `updatedAt` (`docs/agent-layer.md`). Only `values` change a Realm's `version`; `needs` do not.

| Tool               | Input                                                                          | Output                                                                        |
| ------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `appraise`         | `labours: [{ labour, brief?, refs?, values?, links?, needs?, stamp? }]` (1–50) | `{ appraised: [{ labour, stamped }] }`                                        |
| `link_labours`     | `links: [{ type, from, to, note?, remove? }]` (1–50)                           | `{ changed }`                                                                 |
| `get_appraisal`    | `labour`                                                                       | `Appraisal`                                                                   |
| `list_unappraised` | `realm?, include_closed?, limit? (50, max 200), offset? (0)`                   | `{ labours: [{ labour, title, reason }], total, offset, nextOffset \| null }` |

`appraise` is one all-or-nothing write: any error refuses the whole batch. An item writes only what it names, and one naming nothing is fine; the same Labour twice is `invalid`. `brief` is up to 400 characters (`""` clears); `refs` replaces the References (`[]` clears), at most 20, each `{ href, label? }` with `href` 1–500 characters and `label` up to 120, and no `href` twice. `values` is `{ key: value \| null }` as in the Labour's Realm. `needs` is `{ skill: level \| null }`: a level from 1 to 5 sets the Skill the Labour needs, `null` clears it, and Skills not named stay; an unknown Skill or a bad level is `invalid`, as is a Labour that would then need more than 8 Skills. Each `links` entry is `{ type, to \| from, note?, remove? }`: `to` when the appraised Labour is `from`, `from` when it is `to` ("blocked by AM-3" is `{ type: "blocks", from: "AM-3" }`), exactly one of the two. It adds the Link, or re-notes it when `note` is given; a `note` left out keeps the existing one, and removing an absent Link does nothing. A `blocks` Link that would close a cycle is `conflict`. Take `contentHash` from `get_appraisal` before reading a Labour and pass it back as `stamp`: the item is stamped (`stamped: true`) only if it still matches; otherwise its other writes land and `stamped` is `false`. Without `stamp`, `stamped` is `false`.

`link_labours` is one all-or-nothing write of Links by both ends: "AM-3 blocks AM-4" is `{ type: "blocks", from: "AM-3", to: "AM-4" }`. `note`, `remove` and cycle refusal behave as in `appraise`; a self-link is `invalid`. `get_labour` returns the Labour's `links: [{ type, from, to, note }]` beside `labour`.

`list_unappraised` gives each Labour one `reason`: `unappraised` (never stamped), `content` (stamped, but its title, description, Labels or Comments changed since) or `values` (a value set before its Attribute's `revisedAt`). They come in that order, newest Labour first within each. Closed Labours are left out unless `include_closed` is true.

### Surveys

A Survey stores its request and results, kept for `SURVEY_RETENTION_DAYS` (30 by default). It records no Event and never changes a Labour's `updatedAt` (`docs/agent-layer.md`).

| Tool     | Input                                                                                        | Output          |
| -------- | -------------------------------------------------------------------------------------------- | --------------- |
| `survey` | `realm? (all), for? (you), query?, weights, filter?, temperature? (0.3), limit? (15), show?` | `Survey result` |

- `realm` is a Realm or a list of up to 64. `for` is the User the Survey is for. `query` is at most 500 characters; `""` counts as absent.
- `weights` is `{ key: number }`, 1 to 64 keys, each weight in [-10, 10]. A Labour's Score is the sum of weight times feature. A key is one of:
  - a built-in feature, each in [0, 1]: `keywords` (needs `query`), `similarity` (needs `query`), `mentions`, `pulled_in`, `evidence`, `unblocks`, `quest_finish`, `column`, `age`, `activity`, the Sentiment features `sentiment`, `pain` and `delight`, `skill_fit`, and `affinity` (in [-1, 1]);
  - a `scale` Attribute's key, its value scaled to 0..1;
  - a `tags` member as `attr:member`, 1 when the Labour holds it and 0 when not.

  `rank` and `priority` come back in `ignored`, as do `keywords` and `similarity` without a `query`, and a key no surveyed Realm has. A Labour whose Realm lacks the Attribute, or whose value is unset, takes 0.5 and is counted in `coverage.missing`.

- `similarity` is `max(0, (cosine − 0.45) / (1 − 0.45))` between the embedding of `query` and the Labour's, from the local model. A Labour without a current vector takes 0.5 and is counted in `coverage.missing`; so is every candidate when the server runs without its model.
- `skill_fit` is the mean over the Labour's needed Skills of `min(1, held / needed)`, with `held` the level of the Survey's User (`for`) in that Skill, 0 when they lack it. A Labour that needs no Skills, or a User who holds none, takes 0.5 and is counted in `coverage.missing`.
- `sentiment`, `pain` and `delight` read the Sentiment of the Labour's own Realm, as of the Survey's time, over the `scale` Attributes and `tags` members the Labour holds. For each such key `k`, with `x_k` the value scaled to 0..1 (1 for a member) and `v_k` the key's volume against the Realm's loudness, `sentiment = 1 − Π(1 − v_k·x_k)`; `pain` and `delight` weigh each term by the key's mood, `pain` by `max(0, −mood)` and `delight` by `max(0, mood)`. A Labour holding no such value takes 0, never 0.5, and is not counted in `coverage.missing`.
- `affinity` reads the Affinity of the Survey's User (`for`) as of the Survey's time, over the same keys as `sentiment`, with loudness 5: `affinity = delight − pain`, both taken as above from the Affinity's `v_k` and `mood_k`, so it runs from −1 (what they skip) to 1 (what they pick). A Labour holding no such value, or a User with no Affinity, takes 0, never 0.5, and is not counted in `coverage.missing`.
- `filter` takes, all optional: `include_closed` (`true`, or `{ within_days }` above 0 and at most 3650; candidates are Labours in open States otherwise), `assignee` (up to 64 usernames, `"me"` and `null` for unassigned), `has` (up to 32 `attr:member` keys the Labour must all hold), `labels` (up to 20, all carried), `quest` (a Quest id) and `unblocked` (`true` drops every Labour an unfinished Labour blocks).
- `temperature` runs from 0 to 2. At 0 results run by Score, equal Scores in board order (Realm, State, Rank). Above 0 each candidate's Score is shaken by noise scaled to how far the Scores spread, and results run by that; `score` stays the Score.
- `limit` is 1 to 50. `show` is up to 16 Attribute keys whose values each result carries.
- A Score only means something inside its own Survey.

### Outcomes

An Outcome is what became of a Labour a Survey returned. It is an agent layer write: it records no Event and never changes a Labour's `updatedAt` or a Realm's `version`, and any User may report one (`docs/agent-layer.md`). Outcomes are kept with their Survey.

| Tool              | Input                                                   | Output                                          | Kind  |
| ----------------- | ------------------------------------------------------- | ----------------------------------------------- | ----- |
| `report_outcomes` | `survey` (id), `outcomes: [{ labour, verdict }]` (1–50) | `{ outcomes: [{ labour, verdict, recorded }] }` | write |

- `report_outcomes` is one all-or-nothing write. `verdict` is `picked`, `skipped` or `done`. A Labour not among the Survey's stored results (one that `limit` cut included) is `invalid`, an unknown Survey `not_found`. `labour` in the result is the Labour's current key.
- `recorded` is `false` for a verdict the Labour has for that Survey, which changes nothing, also within one batch. `picked` and then `done` are two Outcomes.
- Each new Outcome posts Affinity Pulses to the User the Survey was for, one for every `scale` Attribute or `tags` member the Labour holds a value for, under that key of the Labour's Realm. With `x` the key's value scaled to 0..1 (1 for a member) and skipped when 0, the Pulse's `amount` is `base × x`, with `base` 1 for `picked`, 2 for `done` and 0.5 for `skipped`; its `mood` is +1 for `picked` and `done` and −1 for `skipped`; its half-life is 30 days. Its note names the verdict, the Labour and the Survey, and its evidence is the Labour.

### Skills

A Skill is named once for the whole instance; Users hold Skills at levels 1 to 5, and Labours need them at levels (`appraise`). These are agent layer writes: they record no Events, never change a Realm's `version` or a Labour's `updatedAt`, and any User may set any User's Skills (`docs/agent-layer.md`).

| Tool           | Input                                  | Output                                             | Kind  |
| -------------- | -------------------------------------- | -------------------------------------------------- | ----- |
| `define_skill` | `key, label?, rubric?`                 | `{ skill: Skill }`                                 | write |
| `list_skills`  |                                        | `{ skills: Skill[] }`, by key, each with `holders` | read  |
| `set_skills`   | `user, skills: { key: level \| null }` | `{ user, skills: { key: level } }`                 | write |

- `define_skill` creates the Skill when the key is new (`label` is then required) and otherwise revises the fields given. `key` is lowercase letters, digits and hyphens starting with a letter, at most 32 characters (any case is lowercased). `label` is 1 to 64 characters and `rubric` up to 4,000 (`""` clears), saying what the levels mean.
- `set_skills` sets each named Skill to a level from 1 to 5, or clears it with `null`; Skills not named stay. It is all or nothing: an unknown Skill or a bad level is `invalid`, an unknown User `not_found`. `user` is a username, `"me"` or an id, and the result's `user` a username with the User's whole set of Skills.

### Sentiment

Pulses are agent layer writes: they record no Events, never change a Realm's `version` or a Labour's `updatedAt`, and any User may delete any Pulse (`docs/agent-layer.md`).

| Tool            | Input                                                                                    | Output                                                                                                                           | Kind    |
| --------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `pulse`         | `realm, pulses: [{ key, amount, mood, note?, evidence?, half_life_days?, ref? }]` (1–50) | `{ pulses: [{ index, status, id }] }`                                                                                            | write   |
| `get_sentiment` | `realm \| user, limit? (3, max 20)`                                                      | `{ asOf, keys: [{ realm, key, volume, mood, v, pulses: Pulse[] }], unfiled: [{ rawKey, volume, count, newest: { id, note } }] }` | read    |
| `file_pulses`   | `realm, raw_key, key`                                                                    | `{ filed }`                                                                                                                      | write   |
| `delete_pulse`  | `pulse` (id)                                                                             | `{ deleted: { id } }`                                                                                                            | destroy |

- `get_sentiment` takes exactly one of `realm` and `user` (a username, `"me"` or an id), else `invalid`. For a `user` it gives their Affinity: the same fields, each key's `realm` the key of the Realm it belongs to, loudness fixed at 5, half-lives of 30 days, and `unfiled` always `[]`. Only `report_outcomes` posts Affinity Pulses.
- `pulse` is one all-or-nothing write: any error refuses the whole batch. `key` is `attr` or `attr:member`, each part lowercase letters, digits and hyphens starting with a letter (any case is lowercased). It files when it names a `scale` Attribute of the Realm or a member of one of its `tags` Attributes; any other well-formed key is kept unfiled, with its `raw_key`. `amount` is above 0 and at most 10, `mood` from −1 to 1. `note` is up to 1,000 characters. `evidence` is up to 10 items, each `{ href, label? }` (`href` 1–500 characters, `label` up to 120) or `{ labour }` (a Labour must exist). `half_life_days` is above 0 and at most 365, `null` for a Pulse that never fades, and the Realm's half-life when left out. `ref` is 1–200 characters. A `ref` you used with the same key is `skipped` and its `id` names the earlier Pulse, also within one batch. `status` is `filed`, `unfiled` or `skipped`.
- A Pulse weighs `amount × 2^(−age / half-life)`, or its `amount` without a half-life. For a key, `volume` is the sum of its Pulses' weights, `mood` their weighted mean, and `v = volume / (volume + loudness)`, the Realm's loudness. `get_sentiment` lists only keys with Pulses, loudest first, each with its `limit` heaviest Pulses (ties newest first). `unfiled` has one entry per unfiled `rawKey`, loudest first, with its newest Pulse. `asOf` is the ISO time the weights are for.
- `file_pulses` files every Pulse unfiled under `raw_key`, and every one filed with `raw_key` as its current key, under `key`, and answers how many moved (0 is fine). `key` must file in the Realm, else `invalid`. Pulses keep their `raw_key`. Deleting an Attribute, or removing a `tags` member, unfiles its Pulses and deletes its Affinity Pulses; defining the key afresh does not refile them.
- Pulses with a half-life are deleted once their weight falls below 1% of their `amount`.

### Members and Offers

Realm access is in `docs/realm-access.md`. A Realm you are not a member of is `not_found`, worded as for a key that does not exist. A role too low for the tool is `forbidden`.

| Tool               | Input                            | Output                                                      | Who                                         |
| ------------------ | -------------------------------- | ----------------------------------------------------------- | ------------------------------------------- |
| `list_members`     | `realm`                          | `{ members: [{ user, role, status, invitedBy, … }] }`       | a member; only an Owner sees pending Offers |
| `offer_membership` | `realm, user, role`              | `{ member }`, `status` `pending`                            | Owner                                       |
| `withdraw_offer`   | `realm, user`                    | `{}`                                                        | Owner                                       |
| `set_member_role`  | `realm, user, role`              | `{ member }`                                                | Owner                                       |
| `remove_member`    | `realm, user` (`me` leaves)      | `{}`                                                        | Owner, or the member themselves             |
| `list_offers`      |                                  | `{ offers: [{ realm, name, role, invitedBy, createdAt }] }` | you                                         |
| `accept_offer`     | `realm` (key from `list_offers`) | `{ member }`                                                | the invitee                                 |
| `decline_offer`    | `realm`                          | `{}`                                                        | the invitee                                 |

`remove_member` and a role change refuse to leave a Realm without an Owner (`conflict`). Removing a member clears their Assignee on the Realm's Labours and passes their Owner to the Realm's earliest Owner.

Writes through a token record its name: Events carry `actor.via`, and Comments and agent-layer rows carry `via` (`setBy` and `via` in tool results).

### Users, Invites and API tokens

| Tool                | Input                   | Output                                                                           | Who                                     |
| ------------------- | ----------------------- | -------------------------------------------------------------------------------- | --------------------------------------- |
| `whoami`            |                         | `{ user: User }`                                                                 | anyone                                  |
| `list_users`        |                         | `{ users: User[] }`                                                              | anyone                                  |
| `create_invite`     |                         | `{ id, path }`; join `path` to the origin you connect to                         | Admin                                   |
| `list_invites`      |                         | `{ invites: [{ id, createdBy, createdAt, usedBy, usedAt }] }`                    | Admin                                   |
| `create_agent_user` | `username, displayName` | `{ user: User }`                                                                 | Admin                                   |
| `list_api_tokens`   | `user? (you)`           | `{ tokens: [{ id, name, createdAt, lastUsedAt, revokedAt, expiresAt, oauth }] }` | the User, or an Admin for an Agent user |
| `create_api_token`  | `user? (you), name`     | `{ id, token }`; the secret is shown only here                                   | the User, or an Admin for an Agent user |
| `revoke_api_token`  | `token` (id)            | `{ revoked }`                                                                    | the User, or an Admin for an Agent user |

`expiresAt` is null for a token that never expires; `oauth` is true for a connection's access token (see "OAuth"). Revoking a token closes its event streams at once. A call revoking its own token finishes; the next request with it gets 401.
