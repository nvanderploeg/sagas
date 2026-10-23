import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { questLabours, quests } from '../db/schema.ts';
import type { EventSpec } from '../events/types.ts';
import { DomainError } from './errors.ts';
import { getLabour, getRealm, requireUser } from './lookup.ts';
import { getQuest, readQuest, touchQuest, type Quest, type QuestView } from './quest-view.ts';
import { rankAt, ranksAt, type Placement } from './rank.ts';
import { labourName } from './labour-view.ts';
import { DESCRIPTION_MAX, listChildren } from './labours.ts';
import { requireText } from './validate.ts';
import { requireActiveMember, requireRealmRole } from './access.ts';
import { write, type Actor } from './write.ts';

export {
	listQuestLabours,
	questProgress,
	readQuest,
	type Quest,
	type QuestProgress,
	type QuestView
} from './quest-view.ts';

export type QuestSpec = { realmId: number; name: string; description?: string; ownerId: number };
export type QuestPatch = Partial<Omit<QuestSpec, 'realmId'>>;

// Editing a Quest takes editor access to its Realm; the Labours it lists may be in any Realm.
function editable(tx: Handle, actor: Actor, questId: number): Quest {
	const quest = getQuest(tx, questId);
	requireRealmRole(tx, actor, quest.realmId, 'editor');
	return quest;
}

function membersOf(db: Handle, questId: number) {
	return db
		.select({ id: questLabours.labourId, rank: questLabours.rank })
		.from(questLabours)
		.where(eq(questLabours.questId, questId))
		.orderBy(asc(questLabours.rank))
		.all();
}

export function listQuests(db: Handle): QuestView[] {
	return db
		.select({ id: quests.id })
		.from(quests)
		.orderBy(asc(quests.id))
		.all()
		.map((row) => readQuest(db, row.id));
}

export function listLabourQuests(db: Handle, labourId: number): Quest[] {
	getLabour(db, labourId);
	return db
		.select({ quest: quests })
		.from(questLabours)
		.innerJoin(quests, eq(quests.id, questLabours.questId))
		.where(eq(questLabours.labourId, labourId))
		.orderBy(asc(quests.id))
		.all()
		.map((row) => row.quest);
}

function questOutcome(
	db: Handle,
	questId: number,
	event: (quest: QuestView) => EventSpec
): { value: QuestView; events: EventSpec[] } {
	const quest = readQuest(db, questId);
	return { value: quest, events: [event(quest)] };
}

function checkDescription(value: string): string {
	if (value.length > DESCRIPTION_MAX) {
		throw new DomainError(
			'invalid',
			`Quest description must be at most ${DESCRIPTION_MAX} characters`
		);
	}
	return value;
}

export function createQuest(db: Db, actor: Actor, input: QuestSpec): QuestView {
	const name = requireText(input.name, 'Quest name', 120);
	const description = checkDescription(input.description ?? '');
	return write(db, actor, (tx) => {
		getRealm(tx, input.realmId);
		requireRealmRole(tx, actor, input.realmId, 'editor');
		const ownerId = requireUser(tx, input.ownerId, 'Owner');
		requireActiveMember(tx, input.realmId, ownerId, 'Owner');
		const { id } = tx
			.insert(quests)
			.values({ realmId: input.realmId, name, description, ownerId })
			.returning()
			.get();
		return questOutcome(tx, id, (quest) => ({ type: 'quest.created', data: { quest } }));
	});
}

export function updateQuest(db: Db, actor: Actor, questId: number, patch: QuestPatch): QuestView {
	return write(db, actor, (tx) => {
		const quest = editable(tx, actor, questId);
		const changes: Partial<typeof quests.$inferInsert> = {};
		if (patch.name !== undefined) changes.name = requireText(patch.name, 'Quest name', 120);
		if (patch.description !== undefined) {
			changes.description = checkDescription(patch.description);
		}
		if (patch.ownerId !== undefined) {
			changes.ownerId = requireUser(tx, patch.ownerId, 'Owner');
			requireActiveMember(tx, quest.realmId, changes.ownerId, 'Owner');
		}

		const changed = (Object.keys(changes) as (keyof Quest)[]).some(
			(key) => changes[key as keyof typeof changes] !== quest[key]
		);
		if (!changed) return { value: readQuest(tx, questId), events: [] };
		tx.update(quests)
			.set({ ...changes, updatedAt: new Date() })
			.where(eq(quests.id, questId))
			.run();
		return questOutcome(tx, questId, (quest) => ({ type: 'quest.updated', data: { quest } }));
	});
}

export function deleteQuest(db: Db, actor: Actor, questId: number): void {
	write(db, actor, (tx) => {
		const quest = editable(tx, actor, questId);
		tx.delete(quests).where(eq(quests.id, questId)).run();
		return {
			value: undefined,
			events: [{ type: 'quest.deleted', data: { id: questId, realmId: quest.realmId } }]
		};
	});
}

// Membership is explicit, per CONTEXT.md: never add the Labour's Children here.
export function addQuestLabour(
	db: Db,
	actor: Actor,
	questId: number,
	labourId: number,
	placement: Placement = 'bottom'
): QuestView {
	return write(db, actor, (tx) => {
		editable(tx, actor, questId);
		requireRealmRole(tx, actor, getLabour(tx, labourId).realmId, 'viewer');
		const members = membersOf(tx, questId);
		if (members.some((member) => member.id === labourId)) {
			throw new DomainError('conflict', 'The Labour is already in the Quest');
		}
		insertMember(
			tx,
			questId,
			labourId,
			rankAt(members, { id: labourId }, placement, 'Quest', labourName(tx))
		);
		touchQuest(tx, questId);
		return questOutcome(tx, questId, (quest) => ({
			type: 'quest.labours_added',
			data: { quest, labourIds: [labourId] }
		}));
	});
}

export function addQuestLabourWithChildren(
	db: Db,
	actor: Actor,
	questId: number,
	labourId: number,
	placement: Placement = 'bottom'
): QuestView {
	return write(db, actor, (tx) => {
		editable(tx, actor, questId);
		requireRealmRole(tx, actor, getLabour(tx, labourId).realmId, 'viewer');
		const present = new Set(membersOf(tx, questId).map((member) => member.id));
		const adding = [labourId, ...listChildren(tx, labourId).map((child) => child.id)].filter(
			(id) => !present.has(id)
		);
		for (const id of adding) requireRealmRole(tx, actor, getLabour(tx, id).realmId, 'viewer');
		if (adding.length === 0) {
			throw new DomainError('conflict', 'The Labour and its Children are already in the Quest');
		}
		let next = placement;
		for (const id of adding) {
			insertMember(tx, questId, id, rankAt(membersOf(tx, questId), { id }, next, 'Quest'));
			next = { after: id };
		}
		touchQuest(tx, questId);
		return questOutcome(tx, questId, (quest) => ({
			type: 'quest.labours_added',
			data: { quest, labourIds: adding }
		}));
	});
}

// `labourIds` lists the Labours the write changed, in the order given; `skipped` lists the ones
// already as asked. A Labour listed twice counts once.
export type QuestLaboursChange = { quest: QuestView; labourIds: number[]; skipped: number[] };

function distinctLabours(db: Handle, labourIds: number[]): number[] {
	const distinct = [...new Set(labourIds)];
	for (const id of distinct) getLabour(db, id);
	return distinct;
}

// One write and one Event for the whole list. Membership is explicit, per CONTEXT.md: never add
// the Labours' Children here.
export function addQuestLabours(
	db: Db,
	actor: Actor,
	questId: number,
	labourIds: number[],
	placement: Placement = 'bottom'
): QuestLaboursChange {
	return write(db, actor, (tx) => {
		editable(tx, actor, questId);
		const members = membersOf(tx, questId);
		const present = new Set(members.map((member) => member.id));
		const wanted = distinctLabours(tx, labourIds);
		for (const id of wanted) requireRealmRole(tx, actor, getLabour(tx, id).realmId, 'viewer');
		const adding = wanted.filter((id) => !present.has(id));
		const skipped = wanted.filter((id) => present.has(id));
		if (adding.length === 0) {
			return { value: { quest: readQuest(tx, questId), labourIds: [], skipped }, events: [] };
		}
		const ranks = ranksAt(members, placement, 'Quest', adding.length, labourName(tx));
		tx.insert(questLabours)
			.values(adding.map((labourId, i) => ({ questId, labourId, rank: ranks[i] })))
			.run();
		touchQuest(tx, questId);
		const quest = readQuest(tx, questId);
		return {
			value: { quest, labourIds: adding, skipped },
			events: [{ type: 'quest.labours_added', data: { quest, labourIds: adding } }]
		};
	});
}

export function removeQuestLabours(
	db: Db,
	actor: Actor,
	questId: number,
	labourIds: number[]
): QuestLaboursChange {
	return write(db, actor, (tx) => {
		editable(tx, actor, questId);
		const present = new Set(membersOf(tx, questId).map((member) => member.id));
		const wanted = distinctLabours(tx, labourIds);
		const removing = wanted.filter((id) => present.has(id));
		const skipped = wanted.filter((id) => !present.has(id));
		if (removing.length === 0) {
			return { value: { quest: readQuest(tx, questId), labourIds: [], skipped }, events: [] };
		}
		tx.delete(questLabours)
			.where(and(eq(questLabours.questId, questId), inArray(questLabours.labourId, removing)))
			.run();
		touchQuest(tx, questId);
		const quest = readQuest(tx, questId);
		return {
			value: { quest, labourIds: removing, skipped },
			events: [{ type: 'quest.labours_removed', data: { quest, labourIds: removing } }]
		};
	});
}

export function removeQuestLabour(
	db: Db,
	actor: Actor,
	questId: number,
	labourId: number
): QuestView {
	return write(db, actor, (tx) => {
		editable(tx, actor, questId);
		const removed = tx
			.delete(questLabours)
			.where(and(eq(questLabours.questId, questId), eq(questLabours.labourId, labourId)))
			.run();
		if (removed.changes === 0) throw new DomainError('not_found', 'The Labour is not in the Quest');
		touchQuest(tx, questId);
		return questOutcome(tx, questId, (quest) => ({
			type: 'quest.labours_removed',
			data: { quest, labourIds: [labourId] }
		}));
	});
}

export function rankQuestLabour(
	db: Db,
	actor: Actor,
	questId: number,
	labourId: number,
	placement: Placement
): QuestView {
	return write(db, actor, (tx) => {
		editable(tx, actor, questId);
		const members = membersOf(tx, questId);
		const member = members.find((m) => m.id === labourId);
		if (member === undefined) throw new DomainError('not_found', 'The Labour is not in the Quest');
		const rank = rankAt(members, member, placement, 'Quest', labourName(tx));
		if (rank === member.rank) return { value: readQuest(tx, questId), events: [] };
		tx.update(questLabours)
			.set({ rank })
			.where(and(eq(questLabours.questId, questId), eq(questLabours.labourId, labourId)))
			.run();
		touchQuest(tx, questId);
		return questOutcome(tx, questId, (quest) => ({
			type: 'quest.labour_ranked',
			data: { quest, labourId }
		}));
	});
}

function insertMember(db: Handle, questId: number, labourId: number, rank: string): void {
	db.insert(questLabours).values({ questId, labourId, rank }).run();
}
