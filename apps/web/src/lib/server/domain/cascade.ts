import { and, asc, inArray, not, type SQL } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { questLabours, labours } from '../db/schema.ts';
import type { EventSpec } from '../events/types.ts';
import { readQuest, touchQuest } from './quest-view.ts';
import { readLabour } from './labour-view.ts';

export type Fallout = { orphans: number[]; quests: Map<number, number[]> };

// Call before the delete. Detach Children here, not by the foreign key, so their updatedAt moves.
export function prepareLabourDelete(tx: Handle, doomed: SQL): Fallout {
	const doomedIds = tx.select({ id: labours.id }).from(labours).where(doomed);
	const orphaned = and(inArray(labours.parentId, doomedIds), not(inArray(labours.id, doomedIds)));
	const orphans = tx
		.select({ id: labours.id })
		.from(labours)
		.where(orphaned)
		.orderBy(asc(labours.id))
		.all()
		.map((row) => row.id);
	tx.update(labours).set({ parentId: null, updatedAt: new Date() }).where(orphaned).run();

	const quests = new Map<number, number[]>();
	const memberships = tx
		.select({ questId: questLabours.questId, labourId: questLabours.labourId })
		.from(questLabours)
		.where(inArray(questLabours.labourId, doomedIds))
		.orderBy(asc(questLabours.questId), asc(questLabours.rank))
		.all();
	for (const { questId, labourId } of memberships) {
		quests.set(questId, [...(quests.get(questId) ?? []), labourId]);
	}
	return { orphans, quests };
}

// Call after the delete.
export function falloutEvents(tx: Handle, fallout: Fallout): EventSpec[] {
	for (const questId of fallout.quests.keys()) touchQuest(tx, questId);
	return [
		...fallout.orphans.map((id): EventSpec => ({
			type: 'labour.reparented',
			data: { labour: readLabour(tx, id) }
		})),
		...[...fallout.quests].map(([questId, labourIds]): EventSpec => ({
			type: 'quest.labours_removed',
			data: { quest: readQuest(tx, questId), labourIds }
		}))
	];
}
