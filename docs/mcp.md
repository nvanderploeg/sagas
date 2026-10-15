# MCP

The MCP server at `/mcp`, for agents. Vocabulary is in `CONTEXT.md`; the decision is in `docs/mvp.md`.

## Connecting

- Streamable HTTP, stateless: `POST /mcp` with JSON-RPC, answered with `application/json`. No session id; `GET` and `DELETE` are 405.
- Authenticate every request with `Authorization: Bearer <API token>`. A session cookie is not enough. Otherwise 401.
- Every tool acts as the token's User.

## Arguments

| Kind     | Accepts                                                                             |
| -------- | ----------------------------------------------------------------------------------- |
| Ticket   | Ticket key in any case, former keys (Aliases) included, or internal id              |
| Project  | Project key in any case, former keys included, or id                                |
| State    | State key within the tool's Project, or id                                          |
| Substate | Substate key within its State, or id                                                |
| User     | Username in any case, or id                                                         |
| Quest    | Id                                                                                  |
| Position | At most one of `position: "top" \| "bottom"`, `before: <Ticket>`, `after: <Ticket>` |

An all-digit string is an id. An argument shown with `?` is optional; `| null` clears.

## Results

Every result has `structuredContent` and a short text rendering of it.

- **Ticket**: `{ id, key, title, project, state: { key, label }, substate: { key, label } | null, closed, owner, assignee, parent }`. `project` is its Project key, `owner` and `assignee` usernames, `parent` the Parent's key.
- **TicketDetail**: Ticket plus `{ description, aliases, createdAt, updatedAt, parentTicket: Ticket | null, children: Ticket[], quests: [{ id, name, progress }] }`.
- **Project**: `{ id, key, name, aliases, initialState, states: [{ id, key, label, color, icon, closed, defaultSubstate, substates: [{ id, key, label, color, icon }] }] }`, States and Substates in order. `initialState` and `defaultSubstate` are keys.
- **Quest**: `{ id, name, description, owner, progress: { closed, total }, tickets: Ticket[] }`, members in Quest order.
- **User**: `{ id, username, displayName, kind, isAdmin }`.

An error is a result with `isError: true`, the service's message as text, and `structuredContent: { error: { code, message } }`. `code` is `invalid`, `not_found`, `conflict` or `forbidden`; any other failure is `internal`, with no detail.

## Tools

### Tickets

| Tool            | Input                                                                                                                         | Output                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `resolve`       | `key`                                                                                                                         | `{ ticket: Ticket, alias }`                                |
| `list_tickets`  | `project?, state?, substate?, owner?, assignee? \| null, closed?, quest?, parent? \| null, limit? (50, max 200), offset? (0)` | `{ tickets: Ticket[], total, offset, nextOffset \| null }` |
| `get_ticket`    | `ticket`                                                                                                                      | `{ ticket: TicketDetail }`                                 |
| `create_ticket` | `project, title, description?, owner? (you), assignee?, state?, substate?, parent?, position`                                 | `{ ticket: TicketDetail }`                                 |
| `update_ticket` | `ticket, title?, description?, owner?, assignee? \| null, state?, substate? \| null, position`                                | `{ ticket: TicketDetail }`                                 |
| `move_ticket`   | `ticket, project, state?, substate?, position`                                                                                | `{ ticket: TicketDetail }`                                 |
| `rank_ticket`   | `ticket, position` (required)                                                                                                 | `{ ticket: TicketDetail }`                                 |
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
| `create_state`         | `project, key, label, color, icon, position?` (index among open States) | `{ project }`                                |
| `update_state`         | `project, state, label?, color?, icon?`                                 | `{ project }`                                |
| `reorder_state`        | `project, state, position`                                              | `{ project }`                                |
| `delete_state`         | `project, state`                                                        | `{ project }`                                |
| `create_substate`      | `project, state, key, label, color, icon, position?`                    | `{ project }`                                |
| `update_substate`      | `project, state, substate, label?, color?, icon?`                       | `{ project }`                                |
| `reorder_substate`     | `project, state, substate, position`                                    | `{ project }`                                |
| `delete_substate`      | `project, state, substate`                                              | `{ project }`                                |
| `set_default_substate` | `project, state, substate`                                              | `{ project }`                                |

### Quests

| Tool                   | Input                                        | Output                                                     |
| ---------------------- | -------------------------------------------- | ---------------------------------------------------------- |
| `list_quests`          |                                              | `{ quests: [{ id, name, description, owner, progress }] }` |
| `get_quest`            | `quest`                                      | `{ quest: Quest }`                                         |
| `create_quest`         | `name, description?, owner? (you)`           | `{ quest: Quest }`                                         |
| `update_quest`         | `quest, name?, description?, owner?`         | `{ quest: Quest }`                                         |
| `delete_quest`         | `quest`                                      | `{ deleted: { id, name } }`                                |
| `add_quest_tickets`    | `quest, tickets: Ticket[] (1–100), position` | `{ quest: Quest }`                                         |
| `remove_quest_tickets` | `quest, tickets: Ticket[] (1–100)`           | `{ quest: Quest }`                                         |
| `rank_quest_ticket`    | `quest, ticket, position` (required)         | `{ quest: Quest }`                                         |

`add_quest_tickets` adds the Tickets in the order given and never adds their Children.

### Users, Invites and API tokens

| Tool                | Input                   | Output                                                         | Who                                     |
| ------------------- | ----------------------- | -------------------------------------------------------------- | --------------------------------------- |
| `whoami`            |                         | `{ user: User }`                                               | anyone                                  |
| `list_users`        |                         | `{ users: User[] }`                                            | anyone                                  |
| `create_invite`     |                         | `{ id, path }`, `path` is `/invite/<token>`                    | Admin                                   |
| `list_invites`      |                         | `{ invites: [{ id, createdBy, createdAt, usedBy, usedAt }] }`  | Admin                                   |
| `create_agent_user` | `username, displayName` | `{ user: User }`                                               | Admin                                   |
| `list_api_tokens`   | `user? (you)`           | `{ tokens: [{ id, name, createdAt, lastUsedAt, revokedAt }] }` | the User, or an Admin for an Agent user |
| `create_api_token`  | `user? (you), name`     | `{ id, token }`; the secret is shown only here                 | the User, or an Admin for an Agent user |
| `revoke_api_token`  | `token` (id)            | `{ revoked }`                                                  | the User, or an Admin for an Agent user |
