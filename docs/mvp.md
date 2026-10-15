# MVP

The binding scope and technical decisions for the first release. Vocabulary is in `CONTEXT.md`; where the two disagree, `CONTEXT.md` wins.

## In scope

- **Auth**: first-run `/setup` creates the first Admin and shows that Admin one API token, once. Login, logout, Invites, Agent users, API tokens.
- **Projects**: create, set and rename the Project key, configure States and Substates (Closed's included) and the Initial State.
- **Tickets**: create, edit, delete, move between Projects. Owner, Assignee, title, Markdown description, State and Substate. Parent and Children. Old keys redirect.
- **Board** per Project: one column per State, Substates as badges on cards. Drag between columns to change State; drag within a column to set Rank. Changes from other users appear live.
- **Ticket page**: every field, its Children, a link to its Parent.
- **Quests**: create, edit, add and remove Tickets from any Project, reorder them, progress bar of Closed over total.
- **MCP** at `/mcp`.

## Out of scope

Attachments (first after MVP), comments, history and audit log, blocked flag, search beyond filtering, the workstate panel, workstate moving Tickets, notifications, permissions beyond Admin, priority.

## Decisions

- **Deployment**: one container, adapter-node, SQLite file at `DATABASE_PATH` on a mounted volume. No other services.
- **Passwords**: 7–256 characters.
- **Permissions**: any signed-in User may do anything except manage Users and Invites, which needs an Admin.
- **Moving a Ticket** to another Project: the caller picks the target State and Substate, defaulting to that Project's Initial State. A Ticket in Closed lands in the target's Closed. Its Parent and Children stay where they are.
- **Deleting a Ticket** leaves a gap in its Project's numbering.
- **Rank** is a fractional index within a State's column, so a move writes one row.
- **Live updates**: an in-process event bus feeds server-sent events. Every event carries a monotonically increasing `seq`; a client reconnecting with its last `seq` receives everything after it, without gaps, as workstate's Stream does.
- **MCP**: Streamable HTTP at `/mcp`, authenticated with `Authorization: Bearer <API token>`, acting as that token's User. Tools call the domain services directly; there is no REST API. Tools: `resolve`, ticket list/get/create/update/move/rank/delete, set parent, CRUD for Projects, States and Substates, Quest CRUD plus add/remove/reorder of its Tickets, and Admin tools for Users, Agent users, Invites and tokens. Every Ticket in a tool result carries its current Ticket key.

## Look and motion

Workstate's visual language (`../agent-work-track`: typography, pastel State pills with icons, light/dark/system themes), with more motion and a light game flavor reserved for meaningful events:

- Cards animate to their new place on every move, local or remote (FLIP).
- A remote change briefly glows, tagged with the editing User's avatar.
- Closing a Ticket plays a small loot-style burst.
- Quest progress reads as an XP bar that fills smoothly; reaching 100% shows a "Quest complete" moment.
- Every animation honours `prefers-reduced-motion`.
