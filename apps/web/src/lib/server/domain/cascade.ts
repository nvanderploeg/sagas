import { and, asc, eq, inArray, not, type SQL } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { questLabours, labours } from '../db/schema.ts';
import type { EventSpec } from '../events/types.ts';
import { readQuest, touchQuest } from './quest-view.ts';
import { readLabour } from './labour-view.ts';

export type Fallout = {
	orphans: number[];
	quests: Map<number, number[]>;
	questRealms: Map<number, number[]>;
};

// Call before the delete. Detach Children here, not by the foreign key, so their updatedAt moves.
export async function prepareLabourDelete(tx: Handle, doomed: SQL): Promise<Fallout> {
	const doomedIds = tx.select({ id: labours.id }).from(labours).where(doomed);
	const orphaned = and(inArray(labours.parentId, doomedIds), not(inArray(labours.id, doomedIds)));
	const orphans = (
		await tx.select({ id: labours.id }).from(labours).where(orphaned).orderBy(asc(labours.id))
	).map((row) => row.id);
	await tx.update(labours).set({ parentId: null, updatedAt: new Date() }).where(orphaned);

	const quests = new Map<number, number[]>();
	const memberships = await tx
		.select({
			questId: questLabours.questId,
			labourId: questLabours.labourId,
			realmId: labours.realmId
		})
		.from(questLabours)
		.innerJoin(labours, eq(labours.id, questLabours.labourId))
		.where(inArray(questLabours.labourId, doomedIds))
		.orderBy(asc(questLabours.questId), asc(questLabours.rank));
	const questRealms = new Map<number, number[]>();
	for (const { questId, labourId, realmId } of memberships) {
		quests.set(questId, [...(quests.get(questId) ?? []), labourId]);
		const realms = questRealms.get(questId) ?? [];
		if (!realms.includes(realmId)) questRealms.set(questId, [...realms, realmId]);
	}
	return { orphans, quests, questRealms };
}

// Call after the delete.
export async function falloutEvents(tx: Handle, fallout: Fallout): Promise<EventSpec[]> {
	for (const questId of fallout.quests.keys()) await touchQuest(tx, questId);
	return [
		...(await Promise.all(
			fallout.orphans.map(async (id): Promise<EventSpec> => ({
				type: 'labour.reparented',
				data: { labour: await readLabour(tx, id) }
			}))
		)),
		...(await Promise.all(
			[...fallout.quests].map(async ([questId, labourIds]): Promise<EventSpec> => ({
				type: 'quest.labours_removed',
				data: { quest: await readQuest(tx, questId), labourIds },
				realms: fallout.questRealms.get(questId)
			}))
		))
	];
}
