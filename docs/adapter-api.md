# Adapter API

The contract for external clients (adapters, the command center) that drive sagas without MCP: a REST API under `/api/v1` and the Stream at `/api/events`. Code: `apps/web/src/lib/server/rest/api.ts`; `api.spec.ts` beside it is the executable contract.

## Rules

- Authenticate with `Authorization: Bearer <API token>`. Every request acts as the token's User and sees only Realms that User is an active member of. Without a credential: 401.
- Reads also accept a session cookie. Writes (`PATCH`, `POST`) need a Bearer token; a session alone gets 403.
- Bodies and responses are JSON. Errors are `{"error": "<message>"}`.
- Match Labours by `id`, never by `key`: a move or Realm key rename changes the key. Any former key (alias) still resolves in a path.

| Status | Meaning                                                                                                  |
| ------ | -------------------------------------------------------------------------------------------------------- |
| 400    | Invalid body, unknown body field, bad `limit`/`cursor`, or a body reference (State, user) naming nothing |
| 401    | No valid credential                                                                                      |
| 403    | Session-only write, or a viewer writing                                                                  |
| 404    | Unknown path, or a Realm, Labour or query-referenced State you cannot see or that does not exist         |
| 405    | Method not supported on the path                                                                         |

## Endpoints

### `GET /api/v1/realms`, `GET /api/v1/realms/:key`

`{realms: Realm[]}` or `{realm: Realm}`. `:key` may be a former Realm key.

`Realm`: `{id, key, name, url, states: [{id, key, label, order, closed, substates: [{id, key, label}]}]}`. `states` are in board order (`order` is the index); Closed is last.

### `GET /api/v1/labours?realm=KEY&state=STATE&parent=KEY&limit=N&cursor=C`

Every parameter is optional; `state` needs `realm`. `limit` is 1 to 200 (default 50). Ordered by Realm, State column, then Rank. Returns `{labours: Labour[], total, nextCursor}`; pass `nextCursor` (opaque) as `cursor` for the next page, `null` on the last.

`Labour`: `{id, key, url, realm, title, state, substate, closed, owner, assignee, parent, labels, brief, rank, updatedAt}`. `state` and `substate` are keys (`substate` is `null` without one); `owner`, `assignee` are usernames; `parent` is a Labour key; `brief` is `''` until an agent writes one; `updatedAt` is ISO 8601.

### `GET /api/v1/labours/:key`

`{labour: LabourDetail}`: a `Labour` plus `description` (Markdown), `aliases`, `createdAt`, `links: [{type, from, to, note}]` and `children` (Labour keys).

### `PATCH /api/v1/labours/:key`

Body fields, all optional; any other field is 400:

| Field         | Value                                                              |
| ------------- | ------------------------------------------------------------------ |
| `title`       | string                                                             |
| `description` | string, replaces the whole description                             |
| `assignee`    | username, `"me"`, or `null` to clear                               |
| `state`       | State key in the Labour's Realm; lands at the bottom of the column |
| `substate`    | Substate key, or `null` for the State's default                    |
| `labels`      | string array, replaces the whole set                               |

Same rules as the MCP `update_labour`. Returns `{labour: LabourDetail}`.

### `GET /api/v1/labours/:key/comments`, `POST /api/v1/labours/:key/comments`

`GET` returns `{comments: Comment[]}` oldest first. `POST {"body": "<Markdown>"}` returns 201 `{comment: Comment}`.

`Comment`: `{id, labour, author, body, createdAt, updatedAt}`.

## Consuming `/api/events`

Full contract: `docs/events.md`. In short:

1. Load a view (for example `GET /labours`), then open `GET /api/events` with `?since=<seq>` or `Last-Event-ID: <seq>` (the header wins). A non-integer is 400.
2. Frames are SSE with `id: <seq>`:
   - an Event: `event: <type>`, `data: <Event>`; apply in order, skip any `seq` already applied;
   - `ready` `{seq}`: the replay is done and the Stream is live;
   - `reset` `{seq}`: the resume point cannot be served (older than retention, newer than the log, or a replay over the 8 MiB cap). Refetch every view, then resume from the new `seq`;
   - `seq` `{seq}`: Events up to `seq` concerned nothing you may see; advance your cursor to it;
   - `: ping` heartbeat every 25 s; ignore it.
3. After a disconnect, reconnect with the last `id` received. You get every later Event, or `reset`.
4. Events are retained 7 days (`EVENT_RETENTION_DAYS`). A client offline longer gets `reset`.
5. The Stream closes when the token is revoked. Treat a 401 on reconnect as the end of the credential.
