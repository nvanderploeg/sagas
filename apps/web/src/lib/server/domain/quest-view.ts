import { asc, count, eq, sql } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { questLabours, quests, states, labours } from '../db/schema.ts';
import { DomainError } from './errors.ts';
import { selectLabourViews, toLabourView, type LabourView } from './labour-view.ts';

export type Quest = typeof quests.$inferSelect;
export type QuestProgress = { closed: number; total: number };

// `labours` are the members in Quest order.
export type QuestView = Quest & { labours: LabourView[]; progress: QuestProgress };

export async function getQuest(db: Handle, questId: number): Promise<Quest> {
	const row = (await db.select().from(quests).where(eq(quests.id, questId)).limit(1))[0];
	if (row === undefined) throw new DomainError('not_found', 'Quest not found');
	return row;
}

// Progress follows the Quest definition in CONTEXT.md.
export async function questProgress(db: Handle, questId: number): Promise<QuestProgress> {
	await getQuest(db, questId);
	const row = (
		await db
			.select({
				total: count(),
				closed: sql<number>`coalesce(sum(${states.isClosed}::int), 0)`
			})
			.from(questLabours)
			.innerJoin(labours, eq(labours.id, questLabours.labourId))
			.innerJoin(states, eq(states.id, labours.stateId))
			.where(eq(questLabours.questId, questId))
			.limit(1)
	)[0];
	return { closed: Number(row?.closed ?? 0), total: row?.total ?? 0 };
}

export async function listQuestLabours(db: Handle, questId: number): Promise<LabourView[]> {
	await getQuest(db, questId);
	return (
		await selectLabourViews(db)
			.innerJoin(questLabours, eq(questLabours.labourId, labours.id))
			.where(eq(questLabours.questId, questId))
			.orderBy(asc(questLabours.rank))
	).map(toLabourView);
}

export async function readQuest(db: Handle, questId: number): Promise<QuestView> {
	return {
		...(await getQuest(db, questId)),
		labours: await listQuestLabours(db, questId),
		progress: await questProgress(db, questId)
	};
}

export async function touchQuest(db: Handle, questId: number): Promise<void> {
	await db.update(quests).set({ updatedAt: new Date() }).where(eq(quests.id, questId));
}

// A Quest as a viewer may see it: only Labours in `visible` Realms (null for all), progress
// recounted over those.
export function restrictQuest<
	T extends { labours: { realmId: number; closed: boolean }[]; progress: QuestProgress }
>(quest: T, visible: ReadonlySet<number> | null): T {
	if (visible === null) return quest;
	const shown = quest.labours.filter((labour) => visible.has(labour.realmId));
	return {
		...quest,
		labours: shown,
		progress: { closed: shown.filter((labour) => labour.closed).length, total: shown.length }
	};
}
