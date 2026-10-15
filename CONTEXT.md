# sagas

A labour tracker for a small team, self-hosted as one container with its SQLite file on a mounted volume. Sister to workstate: workstate shows agents' live work, sagas holds the labours that work is for. Terms below are binding vocabulary.

## Language

**User**:
A person or agent who can act in sagas. Has a kind of `human` or `agent`. Owners, assignees and audit entries all point at Users.

**Agent user**:
A User of kind `agent`. Has no password and signs in only with API tokens. Can own and be assigned Labours like any human.

**Admin**:
A User who can manage Users and Invites. The first User, created on the first-run setup screen, is an Admin.

**Invite**:
A single-use link an Admin creates so a person can set their own password and join.

**API token**:
A secret a User creates to call sagas without a browser session, as the MCP server does. The server keeps only its hash. It acts as that User.

**Realm**:
A group of Labours with its own Realm key and State set.

**Realm key**:
2–6 letters or digits starting with a letter, unique across the instance, stored uppercase. Renaming one keeps the old key as an Alias for every Labour in the Realm.

**Labour**:
One unit of tracked work. Has an internal ID that never changes; every relation (parent, Quest, workstate link) points at that, never at the Labour key.

**Labour key**:
`<Realm key>-<number>` (`AM-123`), the human-facing address of a Labour. Accepted in any case. The number comes from a per-Realm counter that only rises; numbers are never reused.

**Alias**:
A Labour key that a Labour used to have. Resolves to the Labour forever. Moving a Labour to another Realm gives it a new Labour key and makes the old one an Alias.

**Owner**:
The User accountable for a Labour.

**Assignee**:
The User who takes the next step on a Labour. May be empty.

**Label**:
A short lowercase tag on a Labour, such as `bug` or `wayfinder:map`; a `:` separates a namespace from a name. Labels are free-form: using one creates it, and a Labour carries at most 20.

**Comment**:
A Markdown note on a Labour, kept with its author and time. Oldest first; only its author can edit or delete it, and it goes when the Labour does.

**Parent**:
The one Labour another Labour sits under. A Labour has at most one Parent; the parent chain never loops.

**Child**:
A Labour whose Parent is the given Labour.

**State**:
A Realm-defined stage of a Labour: key, label, color, icon and position. A Realm's States are its board columns. States carry no meaning beyond their label, except Closed.

**Closed**:
The built-in State every Realm has, always last, which cannot be renamed or removed. A Labour is finished exactly when it is in Closed.

**Initial State**:
The State a new Labour lands in. Each Realm picks its own; it can't be Closed.

**Substate**:
An optional subdivision of one State (`In Progress › Code review`), configured per Realm, Closed included. When a State has Substates, a Labour in that State is always in one of them, and the State names a default Substate to land in.

**Rank**:
A Labour's position within its State's board column, set by dragging. Top is next. There is no priority field.

**Quest**:
A named, ordered set of Labours that may span Realms, with a description and an Owner. A Labour can be in any number of Quests. Membership is explicit: adding a Labour never adds its Children. A Quest has no State; its progress is its Closed Labours over all its Labours.
