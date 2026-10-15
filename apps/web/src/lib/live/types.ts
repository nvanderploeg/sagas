import type { RealmView } from '#lib/server/domain/realm-view.ts';
import type { QuestView } from '#lib/server/domain/quest-view.ts';
import type { CommentView } from '#lib/server/domain/comments.ts';
import type { LabourView } from '#lib/server/domain/labour-view.ts';
import type { EventActor, EventType, Json, SagasEvent } from '#lib/server/events/types.ts';

export type { EventActor, EventType, Json };

export type Labour = Json<LabourView>;
export type Realm = Json<RealmView>;
export type State = Realm['states'][number];
export type Substate = State['substates'][number];
export type Quest = Json<QuestView>;
export type Comment = Json<CommentView>;
export type LiveEvent = Json<SagasEvent>;

export type QuestOption = { id: number; name: string };

export type BoardView = { realm: Realm; labours: Labour[] };

// `mine`: the User's open Labours, owned or assigned. `quests`: the Quests the User owns.
export type HomeView = { realms: Realm[]; mine: Labour[]; quests: Quest[] };

export type QuestPageView = { quest: Quest; realms: Realm[] };

export type QuestListView = { quests: Quest[]; realms: Realm[] };

// `memberOf` lists the ids of the Quests holding the Labour, ascending. `comments` are oldest first.
export type LabourPageView = {
	labour: Labour;
	parent: Labour | null;
	children: Labour[];
	realms: Realm[];
	quests: QuestOption[];
	memberOf: number[];
	comments: Comment[];
};

export type SettingsView = { realm: Realm };

// Every type, so the client can listen for each named SSE event; the compiler keeps it complete.
const TYPES: { [K in EventType]: true } = {
	'realm.created': true,
	'realm.updated': true,
	'realm.deleted': true,
	'state.created': true,
	'state.updated': true,
	'state.deleted': true,
	'substate.created': true,
	'substate.updated': true,
	'substate.deleted': true,
	'labour.created': true,
	'labour.updated': true,
	'labour.moved': true,
	'labour.reparented': true,
	'labour.ranked': true,
	'labour.rekeyed': true,
	'labour.deleted': true,
	'labour.commented': true,
	'labour.comment_edited': true,
	'labour.comment_deleted': true,
	'quest.created': true,
	'quest.updated': true,
	'quest.deleted': true,
	'quest.labours_added': true,
	'quest.labours_removed': true,
	'quest.labour_ranked': true
};

export const EVENT_TYPES = Object.keys(TYPES) as EventType[];
