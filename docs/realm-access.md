# Realm access

Who may see and change a Realm. Vocabulary is in `CONTEXT.md`; this supersedes the MVP decision that any signed-in User may do anything except manage Users and Invites.

## Rules

- A Realm is private. A User with no active Membership cannot see it: its Labours, Quests entries, Events, Surveys and agent layer are all absent, and its keys resolve as not found, the same as a key that does not exist. Admins get no exception.
- Any User may create a Realm and becomes its Owner.
- A **Membership** is one User's role in one Realm: `owner`, `editor` or `viewer`.

| Role   | May                                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| viewer | Read everything in the Realm, including the agent layer.                                                                              |
| editor | Everything a viewer may, plus create, edit, move, rank and delete Labours, write Comments, and change the agent layer.                |
| owner  | Everything an editor may, plus change the Realm itself (name, key, States, Substates, Attributes), delete it, and manage Memberships. |

- A Realm always has at least one Owner. The last Owner cannot leave, be demoted or be removed.
- Admin stays about Users and Invites. An Admin sees a Realm only through a Membership.

## Offers

An Owner adds a User by username with a role. That creates a pending Membership, an **Offer**. The invitee sees their Offers on their account page and over MCP, and accepts or declines. Until accepted, an Offer grants nothing and the invitee cannot see the Realm beyond its name, key and who offered.

- One Membership per User per Realm. Offering to a User who already has one changes nothing; an Owner changes an active role directly.
- An Owner may withdraw an Offer; the invitee may decline it. Either deletes it.
- A member may leave a Realm (not as last Owner). An Owner may remove a member.
- Agent users receive Offers like any User. An agent holding an API token accepts through MCP.

## What a Realm's members mean for its Labours

- Owner and Assignee of a Labour must be active members. Moving a Labour needs `editor` or better in both Realms.
- Removing a member clears their Assignee on the Realm's Labours and hands their Owner to the Realm's earliest Owner. Both are recorded as Events.
- Parent and Link targets in a Realm the caller cannot see read as absent: no key, title or brief is returned, only that something hidden is there.

## Instance-wide things

- Users and Skills stay instance-wide and listable by any User; inviting needs to find people by username.
- A Quest belongs to one Realm and follows its roles: a member sees it, an editor or Owner creates, changes and deletes it. Its Owner is a member of that Realm. Its Labours may be in any Realm: adding one needs only that the caller can see the Labour's Realm. A viewer of the Quest sees only the Labours in Realms they can see, and progress counts only those. Deleting a Realm deletes its Quests.
- A Survey draws only from Realms the subject User is a member of. A request for another User's Survey is allowed only for Realms both belong to.
- Affinity belongs to its User and is readable by that User and by agents acting for them; Pulses it was built from are not exposed across Realms.
- The Event stream, Webhooks and `/api/events` deliver an Event only to a User with an active Membership in the Event's Realm at delivery time. A Quest Event goes by the Quest's Realm.
- Realm keys stay unique across the instance. A key collision with a private Realm discloses that the key is taken; accepted.

## Migration

The first Admin becomes Owner of every existing Realm. Nobody else is a member until offered.

## Enforcement

- One check, `requireRealmRole` in `domain/access.ts`, gates every write in the domain layer; reads take a viewer and filter through `visibleRealmIds` and `canSeeRealm`. No route or tool decides access on its own.
- MCP resolves Realm and Labour arguments through `mcp/refs.ts`, which answers `not_found` for anything the caller cannot see, so a tool never reaches a hidden row.
- Specs run with enforcement off (`test/setup.ts`); the access specs turn it on and act as a non-member, a viewer, an editor and an Owner against one Realm.
- Membership changes record no Events. Only a Realm's Labours, Quests and States do, and an Event reaches only members, per `docs/events.md`.
- The Labour page's "add to Quest" list names the Quests in every Realm the caller can see; adding fails `forbidden` unless they can edit the Quest's Realm.
