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

**OAuth client**:
An app that registered itself to connect on a User's behalf, such as claude.ai; known by its client id.

**Connection**:
One User's consent to one OAuth client: an access token that is an API token, plus a refresh token. Revoking either revokes the Connection.

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
A Realm-defined stage of a Labour: key, label, color, icon, position and whether it is open. A Realm's States are its board columns. States carry no meaning beyond their label, except Closed and open.

**Open**:
A State the Realm marks as ready to move forward: its Labours are the ones a Survey offers. A State that still needs grooming, such as a backlog, is not open. New States start open; Closed is never open.
_Avoid_: using "open" for "not Closed"; say unfinished.

**Next States**:
The States a Realm lists as the usual moves from a State (To do → In Progress; In Progress → To do or Review). Hints only: an agent reads them to pick a move, and the Labour page shows them as buttons under the State field. Any Labour can still be moved to any State.

**Unfinished**:
Not in Closed. A blocker blocks until it is finished, whether or not its State is open.

**Closed**:
The built-in State every Realm has, always last, which cannot be renamed or removed. A Labour is finished exactly when it is in Closed.

**Initial State**:
The State a new Labour lands in. Each Realm picks its own; it can't be Closed.

**Substate**:
An optional subdivision of one State (`In Progress › Code review`), configured per Realm, Closed included. When a State has Substates, a Labour in that State is always in one of them, and the State names a default Substate to land in.

**Rank**:
A Labour's position within its State's board column, set by dragging: the order people give the column. Which Labour to work on next is a Survey's question.

**Quest**:
A named, ordered set of Labours that may span Realms, with a description and an Owner. A Labour can be in any number of Quests. Membership is explicit: adding a Labour never adds its Children. A Quest has no State; its progress is its Closed Labours over all its Labours.

**Agent layer**:
What sagas holds for agents rather than people: Attributes, Appraisals, Links, Mentions, Skills, Sentiment, Affinity, Surveys and Outcomes. Any User may change any of it, whoever set it; each value keeps who set it and when. The contract is `docs/agent-layer.md`.

**Advanced view**:
The switch that shows the agent layer beside what it describes. Off by default; the agent layer shows nowhere else.

**Attribute**:
A value a Realm defines for agents to set on its Labours: a `scale` (an integer range), `tags` (members from the Attribute's own list) or `text`. Its rubric says what each value means. A Realm has at most 32.

**Appraisal**:
An agent's reading of one Labour: its Brief and References, stamped with a hash of the content it read. Stale once the Labour's title, description, Labels or Comments change.

**Brief**:
One or two sentences an agent writes about a Labour for other agents to scan.

**Reference**:
A URL or repository path an agent attaches to a Labour.

**Link**:
A typed connection from one Labour to another: `evidence` (it supports the other), `blocks`, `relates` or `duplicates`. Separate from Parent and Children.

**Mention**:
A Labour key or `@username` in a Labour's description or a Comment, kept with when it first appeared there. sagas derives Mentions from the text; nobody writes them.

**Skill**:
An ability named once for the whole instance, such as `vfx`. A User holds Skills at levels 1–5, and a Labour can need Skills at levels.

**Sentiment**:
How a Realm's audience feels about what its Attributes name: for each `scale` Attribute and each `tags` member, a volume and a mood from −1 to +1, built from Pulses.

**Pulse**:
One report into a Sentiment or an Affinity: an amount and a mood about one key, with a note and evidence. Its weight halves every half-life; a Pulse without one never fades. A Pulse for a key its Realm lacks is unfiled until an agent files it under one.

**Affinity**:
A User's own Sentiment: what they tend to pick or skip, built from the Pulses sagas posts for their Outcomes.

**Survey**:
How an agent answers what to work on next: a request that scores Labours with weights over Attribute keys, `tags` members and built-in features, for one User and an optional query. It returns Labours by Score, shuffled by a temperature, and is kept with its results for 30 days by default.

**Score**:
A Labour's weighted sum in one Survey. Scores from different Surveys don't compare.
_Avoid_: rank, priority

**Outcome**:
What became of a Labour a Survey returned: `picked`, `skipped` or `done`.

**Feeder**:
An Agent user that posts Pulses from what it watches, such as a Discord server or a forum.

**Librarian**:
The Agent user that keeps the agent layer current: it appraises Labours, turns reports into Pulses, files unfiled Pulses and tends each Realm's Attributes. It is the feeder for a Realm's own tickets. Its role is `docs/librarian.md`.

**Webhook**:
A URL a User registers so sagas POSTs it the Events it subscribes to, by Event type and Realm. Its Owner or an Admin manages it. The contract is `docs/webhooks.md`.

**Delivery**:
One signed POST to a Webhook, carrying the next Events it has not received, in seq order. Retried until it succeeds, so a receiver may get the same Events twice.

**Webhook secret**:
The key sagas signs a Webhook's Deliveries with. Shown once; stored encrypted, not hashed, as sagas must read it back to sign.
