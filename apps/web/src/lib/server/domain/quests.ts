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
async function editable(tx: Handle, actor: Actor, questId: number): Promise<Quest> {
	const quest = await getQuest(tx, questId);
	await requireRealmRole(tx, actor, quest.realmId, 'editor');
	return quest;
}

async function membersOf(db: Handle, questId: number) {
	return await db
		.select({ id: questLabours.labourId, rank: questLabours.rank })
		.from(questLabours)
		.where(eq(questLabours.questId, questId))
		.orderBy(asc(questLabours.rank));
}

export async function listQuests(db: Handle): Promise<QuestView[]> {
	const rows = await db.select({ id: quests.id }).from(quests).orderBy(asc(quests.id));
	return Promise.all(rows.map((row) => readQuest(db, row.id)));
}

export async function listLabourQuests(db: Handle, labourId: number): Promise<Quest[]> {
	await getLabour(db, labourId);
	return (
		await db
			.select({ quest: quests })
			.from(questLabours)
			.innerJoin(quests, eq(quests.id, questLabours.questId))
			.where(eq(questLabours.labourId, labourId))
			.orderBy(asc(quests.id))
	).map((row) => row.quest);
}

async function questOutcome(
	db: Handle,
	questId: number,
	event: (quest: QuestView) => EventSpec
): Promise<{ value: QuestView; events: EventSpec[] }> {
	const quest = await readQuest(db, questId);
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

export async function createQuest(db: Db, actor: Actor, input: QuestSpec): Promise<QuestView> {
	const name = requireText(input.name, 'Quest name', 120);
	const description = checkDescription(input.description ?? '');
	return write(db, actor, async (tx) => {
		await getRealm(tx, input.realmId);
		await requireRealmRole(tx, actor, input.realmId, 'editor');
		const ownerId = await requireUser(tx, input.ownerId, 'Owner');
		await requireActiveMember(tx, input.realmId, ownerId, 'Owner');
		const { id } = (
			await tx
				.insert(quests)
				.values({ realmId: input.realmId, name, description, ownerId })
				.returning()
		)[0];
		return questOutcome(tx, id, (quest) => ({ type: 'quest.created', data: { quest } }));
	});
}

export async function updateQuest(
	db: Db,
	actor: Actor,
	questId: number,
	patch: QuestPatch
): Promise<QuestView> {
	return write(db, actor, async (tx) => {
		const quest = await editable(tx, actor, questId);
		const changes: Partial<typeof quests.$inferInsert> = {};
		if (patch.name !== undefined) changes.name = requireText(patch.name, 'Quest name', 120);
		if (patch.description !== undefined) {
			changes.description = checkDescription(patch.description);
		}
		if (patch.ownerId !== undefined) {
			changes.ownerId = await requireUser(tx, patch.ownerId, 'Owner');
			await requireActiveMember(tx, quest.realmId, changes.ownerId, 'Owner');
		}

		const changed = (Object.keys(changes) as (keyof Quest)[]).some(
			(key) => changes[key as keyof typeof changes] !== quest[key]
		);
		if (!changed) return { value: await readQuest(tx, questId), events: [] };
		await tx
			.update(quests)
			.set({ ...changes, updatedAt: new Date() })
			.where(eq(quests.id, questId));
		return questOutcome(tx, questId, (quest) => ({ type: 'quest.updated', data: { quest } }));
	});
}

export async function deleteQuest(db: Db, actor: Actor, questId: number): Promise<void> {
	await write(db, actor, async (tx) => {
		const quest = await editable(tx, actor, questId);
		await tx.delete(quests).where(eq(quests.id, questId));
		return {
			value: undefined,
			events: [{ type: 'quest.deleted', data: { id: questId, realmId: quest.realmId } }]
		};
	});
}

// Membership is explicit, per CONTEXT.md: never add the Labour's Children here.
export async function addQuestLabour(
	db: Db,
	actor: Actor,
	questId: number,
	labourId: number,
	placement: Placement = 'bottom'
): Promise<QuestView> {
	return write(db, actor, async (tx) => {
		await editable(tx, actor, questId);
		await requireRealmRole(tx, actor, (await getLabour(tx, labourId)).realmId, 'viewer');
		const members = await membersOf(tx, questId);
		if (members.some((member) => member.id === labourId)) {
			throw new DomainError('conflict', 'The Labour is already in the Quest');
		}
		await insertMember(
			tx,
			questId,
			labourId,
			await rankAt(members, { id: labourId }, placement, 'Quest', labourName(tx))
		);
		await touchQuest(tx, questId);
		return questOutcome(tx, questId, (quest) => ({
			type: 'quest.labours_added',
			data: { quest, labourIds: [labourId] }
		}));
	});
}

export async function addQuestLabourWithChildren(
	db: Db,
	actor: Actor,
	questId: number,
	labourId: number,
	placement: Placement = 'bottom'
): Promise<QuestView> {
	return write(db, actor, async (tx) => {
		await editable(tx, actor, questId);
		await requireRealmRole(tx, actor, (await getLabour(tx, labourId)).realmId, 'viewer');
		const present = new Set((await membersOf(tx, questId)).map((member) => member.id));
		const adding = [
			labourId,
			...(await listChildren(tx, labourId)).map((child) => child.id)
		].filter((id) => !present.has(id));
		for (const id of adding)
			await requireRealmRole(tx, actor, (await getLabour(tx, id)).realmId, 'viewer');
		if (adding.length === 0) {
			throw new DomainError('conflict', 'The Labour and its Children are already in the Quest');
		}
		let next = placement;
		for (const id of adding) {
			await insertMember(
				tx,
				questId,
				id,
				await rankAt(await membersOf(tx, questId), { id }, next, 'Quest')
			);
			next = { after: id };
		}
		await touchQuest(tx, questId);
		return questOutcome(tx, questId, (quest) => ({
			type: 'quest.labours_added',
			data: { quest, labourIds: adding }
		}));
	});
}

// `labourIds` lists the Labours the write changed, in the order given; `skipped` lists the ones
// already as asked. A Labour listed twice counts once.
export type QuestLaboursChange = { quest: QuestView; labourIds: number[]; skipped: number[] };

async function distinctLabours(db: Handle, labourIds: number[]): Promise<number[]> {
	const distinct = [...new Set(labourIds)];
	for (const id of distinct) await getLabour(db, id);
	return distinct;
}

// One write and one Event for the whole list. Membership is explicit, per CONTEXT.md: never add
// the Labours' Children here.
export async function addQuestLabours(
	db: Db,
	actor: Actor,
	questId: number,
	labourIds: number[],
	placement: Placement = 'bottom'
): Promise<QuestLaboursChange> {
	return write(db, actor, async (tx) => {
		await editable(tx, actor, questId);
		const members = await membersOf(tx, questId);
		const present = new Set(members.map((member) => member.id));
		const wanted = await distinctLabours(tx, labourIds);
		for (const id of wanted)
			await requireRealmRole(tx, actor, (await getLabour(tx, id)).realmId, 'viewer');
		const adding = wanted.filter((id) => !present.has(id));
		const skipped = wanted.filter((id) => present.has(id));
		if (adding.length === 0) {
			return { value: { quest: await readQuest(tx, questId), labourIds: [], skipped }, events: [] };
		}
		const ranks = await ranksAt(members, placement, 'Quest', adding.length, labourName(tx));
		await tx
			.insert(questLabours)
			.values(adding.map((labourId, i) => ({ questId, labourId, rank: ranks[i] })));
		await touchQuest(tx, questId);
		const quest = await readQuest(tx, questId);
		return {
			value: { quest, labourIds: adding, skipped },
			events: [{ type: 'quest.labours_added', data: { quest, labourIds: adding } }]
		};
	});
}

export async function removeQuestLabours(
	db: Db,
	actor: Actor,
	questId: number,
	labourIds: number[]
): Promise<QuestLaboursChange> {
	return write(db, actor, async (tx) => {
		await editable(tx, actor, questId);
		const present = new Set((await membersOf(tx, questId)).map((member) => member.id));
		const wanted = await distinctLabours(tx, labourIds);
		const removing = wanted.filter((id) => present.has(id));
		const skipped = wanted.filter((id) => !present.has(id));
		if (removing.length === 0) {
			return { value: { quest: await readQuest(tx, questId), labourIds: [], skipped }, events: [] };
		}
		await tx
			.delete(questLabours)
			.where(and(eq(questLabours.questId, questId), inArray(questLabours.labourId, removing)));
		await touchQuest(tx, questId);
		const quest = await readQuest(tx, questId);
		return {
			value: { quest, labourIds: removing, skipped },
			events: [{ type: 'quest.labours_removed', data: { quest, labourIds: removing } }]
		};
	});
}

export async function removeQuestLabour(
	db: Db,
	actor: Actor,
	questId: number,
	labourId: number
): Promise<QuestView> {
	return write(db, actor, async (tx) => {
		await editable(tx, actor, questId);
		const removed = await tx
			.delete(questLabours)
			.where(and(eq(questLabours.questId, questId), eq(questLabours.labourId, labourId)));
		if ((removed.rowCount ?? 0) === 0)
			throw new DomainError('not_found', 'The Labour is not in the Quest');
		await touchQuest(tx, questId);
		return questOutcome(tx, questId, (quest) => ({
			type: 'quest.labours_removed',
			data: { quest, labourIds: [labourId] }
		}));
	});
}

export async function rankQuestLabour(
	db: Db,
	actor: Actor,
	questId: number,
	labourId: number,
	placement: Placement
): Promise<QuestView> {
	return write(db, actor, async (tx) => {
		await editable(tx, actor, questId);
		const members = await membersOf(tx, questId);
		const member = members.find((m) => m.id === labourId);
		if (member === undefined) throw new DomainError('not_found', 'The Labour is not in the Quest');
		const rank = await rankAt(members, member, placement, 'Quest', labourName(tx));
		if (rank === member.rank) return { value: await readQuest(tx, questId), events: [] };
		await tx
			.update(questLabours)
			.set({ rank })
			.where(and(eq(questLabours.questId, questId), eq(questLabours.labourId, labourId)));
		await touchQuest(tx, questId);
		return questOutcome(tx, questId, (quest) => ({
			type: 'quest.labour_ranked',
			data: { quest, labourId }
		}));
	});
}

async function insertMember(
	db: Handle,
	questId: number,
	labourId: number,
	rank: string
): Promise<void> {
	await db.insert(questLabours).values({ questId, labourId, rank });
}
