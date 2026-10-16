# MCP

The MCP server at `/mcp`, for agents. Vocabulary is in `CONTEXT.md`; the decision is in `docs/mvp.md`.

## Connecting

- Streamable HTTP, stateless: `POST /mcp` with one JSON-RPC message, answered with `application/json`. No session id. The server declares `tools` only, without `listChanged`.
- Authenticate every request with `Authorization: Bearer <API token>`. A session cookie is not enough. Otherwise 401.
- Every tool acts as the token's User, and every Event its writes record names that User as `actor`.

| Request                                                    | Answer                                                                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `POST` with an `Origin` that is not this server's origin   | 403. A request without `Origin` proceeds on its token.                                                                      |
| A JSON-RPC batch (an array)                                | 400, JSON-RPC error `-32600`.                                                                                               |
| A body over `BODY_SIZE_LIMIT` (adapter-node, 512K default) | 413, JSON-RPC error `-32600`, `Request body too large: it exceeds BODY_SIZE_LIMIT`.                                         |
| Not JSON                                                   | 400, JSON-RPC error `-32700`.                                                                                               |
| `GET`                                                      | 405, `Allow: POST`. 401 first without a token.                                                                              |
| `DELETE`                                                   | 405, `Allow: POST`. 403 first, from SvelteKit's CSRF check, unless it carries a matching `Origin` or a JSON `Content-Type`. |

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

- **Labour**: `{ id, key, path, title, realm, state: { key, label }, substate: { key, label } | null, closed, owner, assignee, parent, labels }`. `realm` is its Realm key, `owner` and `assignee` usernames, `parent` the Parent's key.
- **`path`**: the page of a Labour, Realm or Quest (`/l/AM-123`, `/r/AM`, `/quests/7`). Join it to the origin you connect to to get a link.
- **LabourDetail**: Labour plus `{ description, aliases, createdAt, updatedAt, parentLabour: Labour | null, children: Labour[], quests: [{ id, name, progress }] }`.
- **Comment**: `{ id, labour, author, body, createdAt, updatedAt | null }`. `labour` is the Labour's key, `author` a username, `body` Markdown.
- **Realm**: `{ id, key, path, name, aliases, initialState, states: [{ id, key, label, color, icon, closed, defaultSubstate, substates: [{ id, key, label, color, icon }] }] }`, States and Substates in order. `initialState` and `defaultSubstate` are keys.
- **Quest**: `{ id, path, name, description, owner, progress: { closed, total }, labours: Labour[] }`, members in Quest order.
- **User**: `{ id, username, displayName, kind, isAdmin }`.

An error is a result with `isError: true`, its message as text, and `structuredContent: { error: { code, message } }`. `code` is `invalid` (bad or unknown arguments included), `not_found` (an unknown tool included), `conflict` or `forbidden`; any other failure is `internal`, with no detail. Messages name Labours by key.

## Tools

### Labours

| Tool             | Input                                                                                                                                 | Output                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `resolve`        | `labour`                                                                                                                              | `{ labour: Labour, alias }`                                |
| `list_labours`   | `realm?, state?, substate?, owner?, assignee? \| null, closed?, quest?, parent? \| null, labels?, limit? (50, max 200), offset? (0)`  | `{ labours: Labour[], total, offset, nextOffset \| null }` |
| `get_labour`     | `labour`                                                                                                                              | `{ labour: LabourDetail }`                                 |
| `create_labour`  | `realm, title, description?, owner? (you), assignee?, state?, substate?, parent?, labels?, placement`                                 | `{ labour: LabourDetail }`                                 |
| `update_labour`  | `labour, title?, description?, owner?, assignee? \| null, state?, substate? \| null, labels?, add_labels?, remove_labels?, placement` | `{ labour: LabourDetail }`                                 |
| `move_labour`    | `labour, realm, state?, substate?, placement`                                                                                         | `{ labour: LabourDetail }`                                 |
| `rank_labour`    | `labour, placement` (required)                                                                                                        | `{ labour: LabourDetail }`                                 |
| `set_parent`     | `labour, parent \| null`                                                                                                              | `{ labour: LabourDetail }`                                 |
| `delete_labour`  | `labour`                                                                                                                              | `{ deleted: { id, key } }`                                 |
| `add_comment`    | `labour, body`                                                                                                                        | `{ comment: Comment }`                                     |
| `update_comment` | `comment, body`                                                                                                                       | `{ comment: Comment }`                                     |
| `delete_comment` | `comment`                                                                                                                             | `{ deleted: { id, labour } }`                              |
| `list_comments`  | `labour`                                                                                                                              | `{ comments: Comment[] }`                                  |

`list_labours` orders by Realm, then State order, then Rank; with `quest`, by Quest order. A State key needs `realm`; a Substate key needs `state`; `labels` keeps Labours carrying every one given. On `update_labour`, `labels` replaces the set, then `add_labels` and `remove_labels` adjust it. Comments list oldest first; only a Comment's author can change or delete it (`forbidden` otherwise); `comment` is its id.

### Realms, States and Substates

The Realm's `state` and `substate` arguments resolve within `realm`. Every write returns `{ realm: Realm }`.

| Tool                   | Input                                                                   | Output                                     |
| ---------------------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| `list_realms`          |                                                                         | `{ realms: [{ id, key, name, aliases }] }` |
| `get_realm`            | `realm`                                                                 | `{ realm: Realm }`                         |
| `create_realm`         | `name, key, initialState? { key, label, color, icon }` (default `todo`) | `{ realm }`                                |
| `update_realm`         | `realm, name`                                                           | `{ realm }`                                |
| `rename_realm_key`     | `realm, key`                                                            | `{ realm }`                                |
| `delete_realm`         | `realm`                                                                 | `{ deleted: { id, key } }`                 |
| `set_initial_state`    | `realm, state`                                                          | `{ realm }`                                |
| `create_state`         | `realm, key, label, color, icon, index?` (among open States; last)      | `{ realm }`                                |
| `update_state`         | `realm, state, label?, color?, icon?`                                   | `{ realm }`                                |
| `reorder_state`        | `realm, state, index`                                                   | `{ realm }`                                |
| `delete_state`         | `realm, state`                                                          | `{ realm }`                                |
| `create_substate`      | `realm, state, key, label, color, icon, index?` (last)                  | `{ realm }`                                |
| `update_substate`      | `realm, state, substate, label?, color?, icon?`                         | `{ realm }`                                |
| `reorder_substate`     | `realm, state, substate, index`                                         | `{ realm }`                                |
| `delete_substate`      | `realm, state, substate`                                                | `{ realm }`                                |
| `set_default_substate` | `realm, state, substate`                                                | `{ realm }`                                |

### Quests

| Tool                   | Input                                         | Output                                                           |
| ---------------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| `list_quests`          |                                               | `{ quests: [{ id, path, name, description, owner, progress }] }` |
| `get_quest`            | `quest`                                       | `{ quest: Quest }`                                               |
| `create_quest`         | `name, description?, owner? (you)`            | `{ quest: Quest }`                                               |
| `update_quest`         | `quest, name?, description?, owner?`          | `{ quest: Quest }`                                               |
| `delete_quest`         | `quest`                                       | `{ deleted: { id, name } }`                                      |
| `add_quest_labours`    | `quest, labours: Labour[] (1–100), placement` | `{ quest: Quest, added, skipped }`                               |
| `remove_quest_labours` | `quest, labours: Labour[] (1–100)`            | `{ quest: Quest, removed, skipped }`                             |
| `rank_quest_labour`    | `quest, labour, placement` (required)         | `{ quest: Quest }`                                               |

`add_quest_labours` and `remove_quest_labours` are one write each, recording one `quest.labours_added` or `quest.labours_removed` that names only the Labours that changed. `added`, `removed` and `skipped` are Labour keys. A Labour already as asked is skipped, never an error, so a repeated call is safe; a Labour listed twice counts once; an unknown Labour fails the whole call. Labours are added in the order given, and never with their Children.

### Users, Invites and API tokens

| Tool                | Input                   | Output                                                         | Who                                     |
| ------------------- | ----------------------- | -------------------------------------------------------------- | --------------------------------------- |
| `whoami`            |                         | `{ user: User }`                                               | anyone                                  |
| `list_users`        |                         | `{ users: User[] }`                                            | anyone                                  |
| `create_invite`     |                         | `{ id, path }`; join `path` to the origin you connect to       | Admin                                   |
| `list_invites`      |                         | `{ invites: [{ id, createdBy, createdAt, usedBy, usedAt }] }`  | Admin                                   |
| `create_agent_user` | `username, displayName` | `{ user: User }`                                               | Admin                                   |
| `list_api_tokens`   | `user? (you)`           | `{ tokens: [{ id, name, createdAt, lastUsedAt, revokedAt }] }` | the User, or an Admin for an Agent user |
| `create_api_token`  | `user? (you), name`     | `{ id, token }`; the secret is shown only here                 | the User, or an Admin for an Agent user |
| `revoke_api_token`  | `token` (id)            | `{ revoked }`                                                  | the User, or an Admin for an Agent user |

Revoking a token closes its event streams at once. A call revoking its own token finishes; the next request with it gets 401.
