# Events

The contract for clients of the Stream at `GET /api/events`: the UI and the MCP server. Types are in `apps/web/src/lib/server/events/types.ts`; `apps/web/src/lib/server/events/replica.spec.ts` is an executable client that follows these rules.

## Opening

- Authenticate with the session cookie or `Authorization: Bearer <API token>`. Otherwise 401.
- Resume with `Last-Event-ID: <seq>` or `?since=<seq>`; the header wins. A value that is not a non-negative integer gets 400.
- The server closes the Stream when:
  - its API token is revoked or its session is deleted (logout): at once;
  - its credential stops being valid in any other way, such as session expiry: at the next heartbeat;
  - the client leaves more than the backlog cap (8 MiB) unread. Reconnect with `Last-Event-ID`.

## Frames

| Frame     | Fields                                        | Meaning                                                          |
| --------- | --------------------------------------------- | ---------------------------------------------------------------- |
| Event     | `id: <seq>`, `event: <type>`, `data: <Event>` | One Event; see below.                                            |
| `ready`   | `id: <S>`, `event: ready`, `data: {"seq": S}` | The Stream is live. `S` is the last seq assigned when it opened. |
| `reset`   | `id: <S>`, `event: reset`, `data: {"seq": S}` | The resume point cannot be served. Reload every view.            |
| heartbeat | `: ping`                                      | Every `STREAM_HEARTBEAT_MS` (25 s by default). Ignore it.        |

A connection opens with exactly one of these, then live Events and heartbeats:

- no resume point: `ready`;
- a resume point: every Event after it, in seq order, then `ready`;
- `reset`, then `ready`, when the resume point is older than the oldest retained Event, newer than any seq assigned, or its replay would exceed the backlog cap.

## Resume rules

1. Load each view with `readAtSeq`, which returns `{ seq: L, value }`. The view holds every Event up to `L`.
2. Open the Stream with `since=L`. Alternatively, open it first and drop every Event with `seq <= L`.
3. Apply Events in the order they arrive. Never apply a seq at or below the last one applied.
4. After a disconnect, reconnect with `Last-Event-ID` set to the last `id` received; `EventSource` does this for you. You get every Event after it, with no gap, or `reset`.
5. On `reset`, reload every view as in step 1, and drop Events at or below each view's new `L`.

The server prunes Events older than `EVENT_RETENTION_DAYS` (7 by default). The retained Events are always one contiguous seq range.

## Writes and Events

- A write records one or more Events with consecutive seqs, in one transaction. They are published in seq order after the commit. A write that changes nothing records none.
- The first Event is the write's own. Each one after it is a side effect another client can see.
- Every Event of a write carries state as of the end of that write.
- A view's `L` always falls between writes, never within one.

| Write                         | Events, in order                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| The first Substate of a State | `substate.created`; `ticket.updated` for each Ticket in the State, which moves into the Substate                                   |
| Renaming a Project key        | `project.updated`; `ticket.rekeyed` when the Project has Tickets                                                                   |
| Deleting a Ticket             | `ticket.deleted`; `ticket.reparented` for each of its Children; `quest.tickets_removed` for each Quest it was in                   |
| Deleting a Project            | `project.deleted`; `ticket.reparented` for each Child in another Project; `quest.tickets_removed` for each Quest that lost Tickets |
| Any other write               | One Event                                                                                                                          |

## The Event

```ts
{
	seq: number;
	type: EventType;
	actor: {
		id: number;
		kind: 'human' | 'agent';
		username: string;
		displayName: string;
	}
	createdAt: string; // ISO 8601
	data: EventData[type];
}
```

An Event does not list the Projects it touches. It names the entities it changed and carries their view after the write. Apply it to every view that shows those entities, matching by id.

Views, with dates as ISO strings:

- **ProjectView**: `{ id, name, key, initialStateId, states }`. Each State carries its `substates`. Both are in position order.
- **TicketView**: the Ticket's fields, plus `key`, its current Ticket key, and `closed`, which is true when its State is Closed.
- **QuestView**: the Quest's fields, plus `tickets`, its members as TicketViews in Quest order, and `progress: { closed, total }`.

| Type                    | `data`                                               | Recorded when                                                         |
| ----------------------- | ---------------------------------------------------- | --------------------------------------------------------------------- |
| `project.created`       | `{ project }`                                        | A Project is created.                                                 |
| `project.updated`       | `{ project }`                                        | Its name, key or Initial State changes.                               |
| `project.deleted`       | `{ projectId, ticketIds }`                           | A Project is deleted. `ticketIds` lists every Ticket deleted with it. |
| `state.created`         | `{ project, stateId }`                               | A State is added.                                                     |
| `state.updated`         | `{ project, stateId }`                               | A State is restyled or reordered, or its default Substate changes.    |
| `state.deleted`         | `{ project, stateId }`                               | A State is removed.                                                   |
| `substate.created`      | `{ project, stateId, substateId }`                   | A Substate is added.                                                  |
| `substate.updated`      | `{ project, stateId, substateId }`                   | A Substate is restyled or reordered.                                  |
| `substate.deleted`      | `{ project, stateId, substateId }`                   | A Substate is removed.                                                |
| `ticket.created`        | `{ ticket }`                                         | A Ticket is created.                                                  |
| `ticket.updated`        | `{ ticket }`                                         | Its fields, State or Substate change.                                 |
| `ticket.moved`          | `{ ticket }`                                         | It moves to another Project, which gives it a new key.                |
| `ticket.reparented`     | `{ ticket }`                                         | Its Parent is set or cleared.                                         |
| `ticket.ranked`         | `{ id, stateId, rank }`                              | Only its Rank changes.                                                |
| `ticket.rekeyed`        | `{ projectId, tickets: [{ id, previousKey, key }] }` | Its Project's key is renamed. Lists every Ticket in the Project.      |
| `ticket.deleted`        | `{ id, projectId }`                                  | A Ticket is deleted.                                                  |
| `quest.created`         | `{ quest }`                                          | A Quest is created.                                                   |
| `quest.updated`         | `{ quest }`                                          | Its name, description or Owner changes.                               |
| `quest.deleted`         | `{ id }`                                             | A Quest is deleted.                                                   |
| `quest.tickets_added`   | `{ quest, ticketIds }`                               | Tickets are added to it.                                              |
| `quest.tickets_removed` | `{ quest, ticketIds }`                               | Tickets leave it, whether removed or deleted.                         |
| `quest.ticket_ranked`   | `{ quest, ticketId }`                                | A member is reordered.                                                |

## Applying Events

A board of Project `P` (`readBoard`: `{ project, tickets }`):

- A `project.*`, `state.*` or `substate.*` Event whose `project.id` is `P`: replace `project`.
- `ticket.created`, `ticket.updated`, `ticket.moved` or `ticket.reparented`: if `ticket.projectId` is `P`, upsert the Ticket; otherwise remove it by id.
- `ticket.ranked`: set `stateId` and `rank`. `ticket.rekeyed`: set each `key`.
- `ticket.deleted`, or the `ticketIds` of `project.deleted`: remove those Tickets. A `project.deleted` for `P` ends the board.

A Quest view of Quest `Q` (`readQuest`):

- A `quest.*` Event whose `quest.id` is `Q`: replace the view. `quest.deleted` with id `Q` ends it.
- `ticket.updated`, `ticket.moved`, `ticket.reparented`, `ticket.ranked` or `ticket.rekeyed` for a member: update that member.
- Recompute `progress` from the members' `closed` after any member changes. A member's change does not record a Quest Event.

A list of a Ticket's Children follows each Child's `parentId`. A new Parent named by `ticket.reparented` is not in its data; load it.
