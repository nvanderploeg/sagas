# workload

A ticket tracker for a small team, self-hosted as one container with its SQLite file on a mounted volume. Sister to workstate: workstate shows agents' live work, workload holds the tickets that work is for. Terms below are binding vocabulary.

## Language

**User**:
A person or agent who can act in workload. Has a kind of `human` or `agent`. Owners, assignees and audit entries all point at Users.

**Agent user**:
A User of kind `agent`. Has no password and signs in only with API tokens. Can own and be assigned Tickets like any human.

**Admin**:
A User who can manage Users and Invites. The first User, created on the first-run setup screen, is an Admin.

**Invite**:
A single-use link an Admin creates so a person can set their own password and join.

**API token**:
A secret a User creates to call workload without a browser session, as the MCP server does. The server keeps only its hash. It acts as that User.

**Project**:
A group of Tickets with its own Project key and State set.

**Project key**:
2–6 letters or digits starting with a letter, unique across the instance, stored uppercase. Renaming one keeps the old key as an Alias for every Ticket in the Project.

**Ticket**:
One unit of tracked work. Has an internal ID that never changes; every relation (parent, Quest, workstate link) points at that, never at the Ticket key.

**Ticket key**:
`<Project key>-<number>` (`AM-123`), the human-facing address of a Ticket. Accepted in any case. The number comes from a per-Project counter that only rises; numbers are never reused.

**Alias**:
A Ticket key that a Ticket used to have. Resolves to the Ticket forever. Moving a Ticket to another Project gives it a new Ticket key and makes the old one an Alias.

**Owner**:
The User accountable for a Ticket.

**Assignee**:
The User who takes the next step on a Ticket. May be empty.

**Parent**:
The one Ticket another Ticket sits under. A Ticket has at most one Parent; the parent chain never loops.

**Child**:
A Ticket whose Parent is the given Ticket.

**State**:
A Project-defined stage of a Ticket: key, label, color, icon and position. A Project's States are its board columns. States carry no meaning beyond their label, except Closed.

**Closed**:
The built-in State every Project has, always last, which cannot be renamed or removed. A Ticket is finished exactly when it is in Closed.

**Initial State**:
The State a new Ticket lands in. Each Project picks its own; it can't be Closed.

**Substate**:
An optional subdivision of one State (`In Progress › Code review`), configured per Project, Closed included. When a State has Substates, a Ticket in that State is always in one of them, and the State names a default Substate to land in.

**Rank**:
A Ticket's position within its State's board column, set by dragging. Top is next. There is no priority field.

**Quest**:
A named, ordered set of Tickets that may span Projects, with a description and an Owner. A Ticket can be in any number of Quests. Membership is explicit: adding a Ticket never adds its Children. A Quest has no State; its progress is its Closed Tickets over all its Tickets.
