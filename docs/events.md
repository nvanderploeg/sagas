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

| Frame     | Fields                                        | Meaning                                                                                                         |
| --------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Event     | `id: <seq>`, `event: <type>`, `data: <Event>` | One Event; see below.                                                                                           |
| `ready`   | `id: <S>`, `event: ready`, `data: {"seq": S}` | The Stream is live. `S` is the last seq assigned when it opened.                                                |
| `reset`   | `id: <S>`, `event: reset`, `data: {"seq": S}` | The resume point cannot be served. Reload every view.                                                           |
| `seq`     | `id: <S>`, `event: seq`, `data: {"seq": S}`   | Events up to `S` concerned nothing you may see. Treat every view as having applied them. Sent with a heartbeat. |
| heartbeat | `: ping`                                      | Every `STREAM_HEARTBEAT_MS` (25 s by default). Ignore it.                                                       |

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

## Who receives an Event

A Stream carries an Event only when its User is an active member of the Event's Realm when it is sent, as in `docs/realm-access.md`; replay filters the same way, so a `seq` can be skipped. A Quest Event lists only the Labours in Realms the User can see, with progress recounted over them. A `labour.moved` into a Realm the User cannot see, out of one they can, arrives as `labour.deleted`. `realm.deleted` goes to every Stream: its Memberships are gone, and it carries only ids.

Webhooks deliver the same Events to outside services by POST: `docs/webhooks.md`.

## Writes and Events

- A write records one or more Events with consecutive seqs, in one transaction. They are published in seq order after the commit. A write that changes nothing records none. Agent layer writes (`docs/agent-layer.md`) record none either.
- The first Event is the write's own. Each one after it is a side effect another client can see.
- Every Event of a write carries state as of the end of that write.
- A view's `L` always falls between writes, never within one.

| Write                         | Events, in order                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| The first Substate of a State | `substate.created`; `labour.updated` for each Labour in the State, which moves into the Substate                               |
| Renaming a Realm key          | `realm.updated`; `labour.rekeyed` when the Realm has Labours                                                                   |
| Deleting a Labour             | `labour.deleted`; `labour.reparented` for each of its Children; `quest.labours_removed` for each Quest it was in               |
| Deleting a Realm              | `realm.deleted`; `labour.reparented` for each Child in another Realm; `quest.labours_removed` for each Quest that lost Labours |
| Any other write               | One Event                                                                                                                      |

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
		via: { tokenId: number | null; name: string } | null;
	}
	createdAt: string; // ISO 8601
	data: EventData[type];
}
```

`actor.via` names the API token the write came through, as it was named then; `tokenId` is null once the token is deleted. It is null for a write made from a browser session. A client that skips Events it caused itself must skip only those with a null `via`, since an agent acting as the same User is a different source.

An Event does not list the Realms it touches. It names the entities it changed and carries their view after the write. Apply it to every view that shows those entities, matching by id.

Views, with dates as ISO strings:

- **RealmView**: `{ id, name, key, initialStateId, states }`. Each State carries its `substates`. Both are in position order.
- **LabourView**: the Labour's fields, plus `key`, its current Labour key, and `closed`, which is true when its State is Closed.
- **CommentView**: the Comment's fields: `{ id, labourId, authorId, body, createdAt, updatedAt }`, `updatedAt` null until edited.
- **QuestView**: the Quest's fields, plus `labours`, its members as LabourViews in Quest order, and `progress: { closed, total }`.

| Type                     | `data`                                             | Recorded when                                                       |
| ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------- |
| `realm.created`          | `{ realm }`                                        | A Realm is created.                                                 |
| `realm.updated`          | `{ realm }`                                        | Its name, key or Initial State changes.                             |
| `realm.deleted`          | `{ realmId, labourIds }`                           | A Realm is deleted. `labourIds` lists every Labour deleted with it. |
| `state.created`          | `{ realm, stateId }`                               | A State is added.                                                   |
| `state.updated`          | `{ realm, stateId }`                               | A State is restyled or reordered, or its default Substate changes.  |
| `state.deleted`          | `{ realm, stateId }`                               | A State is removed.                                                 |
| `substate.created`       | `{ realm, stateId, substateId }`                   | A Substate is added.                                                |
| `substate.updated`       | `{ realm, stateId, substateId }`                   | A Substate is restyled or reordered.                                |
| `substate.deleted`       | `{ realm, stateId, substateId }`                   | A Substate is removed.                                              |
| `labour.created`         | `{ labour }`                                       | A Labour is created.                                                |
| `labour.updated`         | `{ labour }`                                       | Its fields, State or Substate change.                               |
| `labour.moved`           | `{ labour, fromRealmId }`                          | It moves to another Realm, which gives it a new key.                |
| `labour.reparented`      | `{ labour }`                                       | Its Parent is set or cleared.                                       |
| `labour.ranked`          | `{ id, stateId, rank }`                            | Only its Rank changes.                                              |
| `labour.rekeyed`         | `{ realmId, labours: [{ id, previousKey, key }] }` | Its Realm's key is renamed. Lists every Labour in the Realm.        |
| `labour.deleted`         | `{ id, realmId }`                                  | A Labour is deleted.                                                |
| `labour.commented`       | `{ comment }`                                      | A Comment is added to a Labour.                                     |
| `labour.comment_edited`  | `{ comment }`                                      | A Comment's body changes.                                           |
| `labour.comment_deleted` | `{ id, labourId }`                                 | A Comment is deleted.                                               |
| `quest.created`          | `{ quest }`                                        | A Quest is created.                                                 |
| `quest.updated`          | `{ quest }`                                        | Its name, description or Owner changes.                             |
| `quest.deleted`          | `{ id }`                                           | A Quest is deleted.                                                 |
| `quest.labours_added`    | `{ quest, labourIds }`                             | Labours are added to it.                                            |
| `quest.labours_removed`  | `{ quest, labourIds }`                             | Labours leave it, whether removed or deleted.                       |
| `quest.labour_ranked`    | `{ quest, labourId }`                              | A member is reordered.                                              |

## Applying Events

A board of Realm `P` (`readBoard`: `{ realm, labours }`):

- A `realm.*`, `state.*` or `substate.*` Event whose `realm.id` is `P`: replace `realm`.
- `labour.created`, `labour.updated`, `labour.moved` or `labour.reparented`: if `labour.realmId` is `P`, upsert the Labour; otherwise remove it by id.
- `labour.ranked`: set `stateId` and `rank`. `labour.rekeyed`: set each `key`.
- `labour.deleted`, or the `labourIds` of `realm.deleted`: remove those Labours. A `realm.deleted` for `P` ends the board.

A Quest view of Quest `Q` (`readQuest`):

- A `quest.*` Event whose `quest.id` is `Q`: replace the view. `quest.deleted` with id `Q` ends it.
- `labour.updated`, `labour.moved`, `labour.reparented`, `labour.ranked` or `labour.rekeyed` for a member: update that member.
- Recompute `progress` from the members' `closed` after any member changes. A member's change does not record a Quest Event.

A Labour page (`readLabourPage`) holds the Labour's `comments`, oldest first. `labour.commented` for that Labour appends its `comment` unless one with that `id` is already there. `labour.comment_edited` replaces the Comment with that `id`; `labour.comment_deleted` removes it. No other view shows Comments, and they go with their Labour.

A list of a Labour's Children follows each Child's `parentId`. A new Parent named by `labour.reparented` is not in its data; load it.
