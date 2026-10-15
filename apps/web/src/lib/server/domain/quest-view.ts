import { asc, count, eq, sql } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { questLabours, quests, states, labours } from '../db/schema.ts';
import { DomainError } from './errors.ts';
import { selectLabourViews, toLabourView, type LabourView } from './labour-view.ts';

export type Quest = typeof quests.$inferSelect;
export type QuestProgress = { closed: number; total: number };

// `labours` are the members in Quest order.
export type QuestView = Quest & { labours: LabourView[]; progress: QuestProgress };

export function getQuest(db: Handle, questId: number): Quest {
	const row = db.select().from(quests).where(eq(quests.id, questId)).get();
	if (row === undefined) throw new DomainError('not_found', 'Quest not found');
	return row;
}

// Progress follows the Quest definition in CONTEXT.md.
export function questProgress(db: Handle, questId: number): QuestProgress {
	getQuest(db, questId);
	const row = db
		.select({
			total: count(),
			closed: sql<number>`coalesce(sum(${states.isClosed}), 0)`
		})
		.from(questLabours)
		.innerJoin(labours, eq(labours.id, questLabours.labourId))
		.innerJoin(states, eq(states.id, labours.stateId))
		.where(eq(questLabours.questId, questId))
		.get();
	return { closed: Number(row?.closed ?? 0), total: row?.total ?? 0 };
}

export function listQuestLabours(db: Handle, questId: number): LabourView[] {
	getQuest(db, questId);
	return selectLabourViews(db)
		.innerJoin(questLabours, eq(questLabours.labourId, labours.id))
		.where(eq(questLabours.questId, questId))
		.orderBy(asc(questLabours.rank))
		.all()
		.map(toLabourView);
}

export function readQuest(db: Handle, questId: number): QuestView {
	return {
		...getQuest(db, questId),
		labours: listQuestLabours(db, questId),
		progress: questProgress(db, questId)
	};
}

export function touchQuest(db: Handle, questId: number): void {
	db.update(quests).set({ updatedAt: new Date() }).where(eq(quests.id, questId)).run();
}
