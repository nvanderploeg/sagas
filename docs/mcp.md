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
| Ticket    | Ticket key in any case, former keys (Aliases) included, or id                                                                |
| Project   | Project key in any case, former keys included, or id                                                                         |
| State     | State key within the tool's Project, or id                                                                                   |
| Substate  | Substate key within its State, or id                                                                                         |
| User      | Username in any case, `"me"` for the token's User, or id                                                                     |
| Quest     | Id                                                                                                                           |
| Placement | Of a Ticket in its column or in a Quest: at most one of `position: "top" \| "bottom"`, `before: <Ticket>`, `after: <Ticket>` |
| Index     | Of a State or Substate: `index`, 0-based                                                                                     |

- An id is a JSON number. A string is always a key or a username; a string of digits is `invalid`.
- `"me"` always means the token's User; reach a User named `me` by id.
- Unknown arguments are `invalid`, and the message names them.
- An argument shown with `?` is optional; `| null` clears.

## Results

A result has `structuredContent` and one text item: a one-line summary, a newline, then `structuredContent` as JSON. A Ticket's summary shows its State and Substate keys and labels: `AM-1 [doing: Doing › review: Review] Title`.

- **Ticket**: `{ id, key, title, project, state: { key, label }, substate: { key, label } | null, closed, owner, assignee, parent }`. `project` is its Project key, `owner` and `assignee` usernames, `parent` the Parent's key.
- **TicketDetail**: Ticket plus `{ description, aliases, createdAt, updatedAt, parentTicket: Ticket | null, children: Ticket[], quests: [{ id, name, progress }] }`.
- **Project**: `{ id, key, name, aliases, initialState, states: [{ id, key, label, color, icon, closed, defaultSubstate, substates: [{ id, key, label, color, icon }] }] }`, States and Substates in order. `initialState` and `defaultSubstate` are keys.
- **Quest**: `{ id, name, description, owner, progress: { closed, total }, tickets: Ticket[] }`, members in Quest order.
- **User**: `{ id, username, displayName, kind, isAdmin }`.

An error is a result with `isError: true`, its message as text, and `structuredContent: { error: { code, message } }`. `code` is `invalid` (bad or unknown arguments included), `not_found` (an unknown tool included), `conflict` or `forbidden`; any other failure is `internal`, with no detail. Messages name Tickets by key.

## Tools

### Tickets

| Tool            | Input                                                                                                                         | Output                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `resolve`       | `ticket`                                                                                                                      | `{ ticket: Ticket, alias }`                                |
| `list_tickets`  | `project?, state?, substate?, owner?, assignee? \| null, closed?, quest?, parent? \| null, limit? (50, max 200), offset? (0)` | `{ tickets: Ticket[], total, offset, nextOffset \| null }` |
| `get_ticket`    | `ticket`                                                                                                                      | `{ ticket: TicketDetail }`                                 |
| `create_ticket` | `project, title, description?, owner? (you), assignee?, state?, substate?, parent?, placement`                                | `{ ticket: TicketDetail }`                                 |
| `update_ticket` | `ticket, title?, description?, owner?, assignee? \| null, state?, substate? \| null, placement`                               | `{ ticket: TicketDetail }`                                 |
| `move_ticket`   | `ticket, project, state?, substate?, placement`                                                                               | `{ ticket: TicketDetail }`                                 |
| `rank_ticket`   | `ticket, placement` (required)                                                                                                | `{ ticket: TicketDetail }`                                 |
| `set_parent`    | `ticket, parent \| null`                                                                                                      | `{ ticket: TicketDetail }`                                 |
| `delete_ticket` | `ticket`                                                                                                                      | `{ deleted: { id, key } }`                                 |

`list_tickets` orders by Project, then State order, then Rank; with `quest`, by Quest order. A State key needs `project`; a Substate key needs `state`.

### Projects, States and Substates

The Project's `state` and `substate` arguments resolve within `project`. Every write returns `{ project: Project }`.

| Tool                   | Input                                                                   | Output                                       |
| ---------------------- | ----------------------------------------------------------------------- | -------------------------------------------- |
| `list_projects`        |                                                                         | `{ projects: [{ id, key, name, aliases }] }` |
| `get_project`          | `project`                                                               | `{ project: Project }`                       |
| `create_project`       | `name, key, initialState? { key, label, color, icon }` (default `todo`) | `{ project }`                                |
| `update_project`       | `project, name`                                                         | `{ project }`                                |
| `rename_project_key`   | `project, key`                                                          | `{ project }`                                |
| `delete_project`       | `project`                                                               | `{ deleted: { id, key } }`                   |
| `set_initial_state`    | `project, state`                                                        | `{ project }`                                |
| `create_state`         | `project, key, label, color, icon, index?` (among open States; last)    | `{ project }`                                |
| `update_state`         | `project, state, label?, color?, icon?`                                 | `{ project }`                                |
| `reorder_state`        | `project, state, index`                                                 | `{ project }`                                |
| `delete_state`         | `project, state`                                                        | `{ project }`                                |
| `create_substate`      | `project, state, key, label, color, icon, index?` (last)                | `{ project }`                                |
| `update_substate`      | `project, state, substate, label?, color?, icon?`                       | `{ project }`                                |
| `reorder_substate`     | `project, state, substate, index`                                       | `{ project }`                                |
| `delete_substate`      | `project, state, substate`                                              | `{ project }`                                |
| `set_default_substate` | `project, state, substate`                                              | `{ project }`                                |

### Quests

| Tool                   | Input                                         | Output                                                     |
| ---------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| `list_quests`          |                                               | `{ quests: [{ id, name, description, owner, progress }] }` |
| `get_quest`            | `quest`                                       | `{ quest: Quest }`                                         |
| `create_quest`         | `name, description?, owner? (you)`            | `{ quest: Quest }`                                         |
| `update_quest`         | `quest, name?, description?, owner?`          | `{ quest: Quest }`                                         |
| `delete_quest`         | `quest`                                       | `{ deleted: { id, name } }`                                |
| `add_quest_tickets`    | `quest, tickets: Ticket[] (1–100), placement` | `{ quest: Quest, added, skipped }`                         |
| `remove_quest_tickets` | `quest, tickets: Ticket[] (1–100)`            | `{ quest: Quest, removed, skipped }`                       |
| `rank_quest_ticket`    | `quest, ticket, placement` (required)         | `{ quest: Quest }`                                         |

`add_quest_tickets` and `remove_quest_tickets` are one write each, recording one `quest.tickets_added` or `quest.tickets_removed` that names only the Tickets that changed. `added`, `removed` and `skipped` are Ticket keys. A Ticket already as asked is skipped, never an error, so a repeated call is safe; a Ticket listed twice counts once; an unknown Ticket fails the whole call. Tickets are added in the order given, and never with their Children.

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
