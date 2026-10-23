import type { RealmView } from '../domain/realm-view.ts';
import type { QuestView } from '../domain/quest-view.ts';
import type { CommentView } from '../domain/comments.ts';
import type { LabourView } from '../domain/labour-view.ts';

// The contract is docs/events.md: change both together.
//
// No Event lists the Realms it touches. Each names the entities it changed and carries their
// view after the write, and a client applies it to every view that shows those entities.
export type EventData = {
	'realm.created': { realm: RealmView };
	'realm.updated': { realm: RealmView };
	'realm.deleted': { realmId: number; labourIds: number[] };
	'state.created': { realm: RealmView; stateId: number };
	'state.updated': { realm: RealmView; stateId: number };
	'state.deleted': { realm: RealmView; stateId: number };
	'substate.created': { realm: RealmView; stateId: number; substateId: number };
	'substate.updated': { realm: RealmView; stateId: number; substateId: number };
	'substate.deleted': { realm: RealmView; stateId: number; substateId: number };
	'labour.created': { labour: LabourView };
	'labour.updated': { labour: LabourView };
	'labour.moved': { labour: LabourView; fromRealmId: number };
	'labour.reparented': { labour: LabourView };
	'labour.ranked': { id: number; stateId: number; rank: string };
	'labour.rekeyed': {
		realmId: number;
		labours: { id: number; previousKey: string; key: string }[];
	};
	'labour.deleted': { id: number; realmId: number };
	'labour.commented': { comment: CommentView };
	'labour.comment_edited': { comment: CommentView };
	'labour.comment_deleted': { id: number; labourId: number };
	'quest.created': { quest: QuestView };
	'quest.updated': { quest: QuestView };
	'quest.deleted': { id: number; realmId: number };
	'quest.labours_added': { quest: QuestView; labourIds: number[] };
	'quest.labours_removed': { quest: QuestView; labourIds: number[] };
	'quest.labour_ranked': { quest: QuestView; labourId: number };
};

export type EventType = keyof EventData;

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

export const EVENT_TYPES = Object.keys(TYPES) as [EventType, ...EventType[]];

export type EventVia = { tokenId: number | null; name: string };

export type EventActor = {
	id: number;
	via: EventVia | null;
	kind: 'human' | 'agent';
	username: string;
	displayName: string;
};

// The JSON form of a value: dates arrive as ISO strings.
export type Json<T> = T extends Date
	? string
	: T extends (infer U)[]
		? Json<U>[]
		: T extends object
			? { [K in keyof T]: Json<T[K]> }
			: T;

export type EventSpec = { [K in EventType]: { type: K; data: EventData[K] } }[EventType];

export type SagasEvent = {
	[K in EventType]: {
		seq: number;
		type: K;
		actor: EventActor;
		createdAt: Date;
		data: Json<EventData[K]>;
	};
}[EventType];
