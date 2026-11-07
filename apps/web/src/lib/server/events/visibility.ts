import { inArray, eq } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { labours, realms, states } from '../db/schema.ts';
import { visibleRealmIds } from '../domain/access.ts';
import { restrictQuest } from '../domain/quest-view.ts';
import type { SagasEvent } from './types.ts';

async function realmExists(db: Handle, id: number): Promise<boolean> {
	return (
		(await db.select({ id: realms.id }).from(realms).where(eq(realms.id, id)).limit(1))[0] !==
		undefined
	);
}

async function realmOfLabour(db: Handle, id: number): Promise<number | null> {
	return (
		(
			await db.select({ realmId: labours.realmId }).from(labours).where(eq(labours.id, id)).limit(1)
		)[0]?.realmId ?? null
	);
}

// The Event as one viewer may see it, or null when it concerns nothing they can see. Per
// the product/realm-access Scroll, membership is read now, not when the Event happened.
export async function eventForViewer(
	db: Handle,
	event: SagasEvent,
	viewer: { id: number }
): Promise<SagasEvent | null> {
	const ids = await visibleRealmIds(db, viewer);
	if (ids === null) return event;
	const visible = new Set(ids);
	const sees = (realmId: number | null) => realmId !== null && visible.has(realmId);

	switch (event.type) {
		case 'realm.created':
		case 'realm.updated':
		case 'state.created':
		case 'state.updated':
		case 'state.deleted':
		case 'substate.created':
		case 'substate.updated':
		case 'substate.deleted':
			return sees(event.data.realm.id) ? event : null;
		case 'realm.deleted':
			// The Realm's Memberships went with it, so no recipient can be checked.
			return event;
		case 'labour.created':
		case 'labour.updated':
		case 'labour.reparented':
			return sees(event.data.labour.realmId) ? event : null;
		case 'labour.moved': {
			if (sees(event.data.labour.realmId)) return event;
			if (!sees(event.data.fromRealmId)) return null;
			return {
				...event,
				type: 'labour.deleted',
				data: { id: event.data.labour.id, realmId: event.data.fromRealmId }
			} as SagasEvent;
		}
		case 'labour.ranked': {
			const state = (
				await db
					.select({ realmId: states.realmId })
					.from(states)
					.where(eq(states.id, event.data.stateId))
					.limit(1)
			)[0];
			return sees(state?.realmId ?? null) ? event : null;
		}
		case 'labour.rekeyed':
		case 'labour.deleted':
			return sees(event.data.realmId) ? event : null;
		case 'labour.commented':
		case 'labour.comment_edited':
			return sees(await realmOfLabour(db, event.data.comment.labourId)) ? event : null;
		case 'labour.comment_deleted':
			return sees(await realmOfLabour(db, event.data.labourId)) ? event : null;
		case 'quest.created':
		case 'quest.updated':
		case 'quest.labour_ranked':
			if (!sees(event.data.quest.realmId)) return null;
			return {
				...event,
				data: { ...event.data, quest: restrictQuest(event.data.quest, visible) }
			} as SagasEvent;
		case 'quest.deleted':
			// A Realm's deletion takes its Memberships with it, so its Quests go to every Stream.
			return sees(event.data.realmId) || !(await realmExists(db, event.data.realmId))
				? event
				: null;
		case 'scroll.created':
		case 'scroll.updated':
		case 'scroll.moved':
			return sees(event.data.scroll.realmId) ? event : null;
		case 'scroll.deleted':
			return sees(event.data.realmId) ? event : null;
		case 'quest.labours_added':
		case 'quest.labours_removed': {
			if (!sees(event.data.quest.realmId)) return null;
			const rows = event.data.labourIds.length
				? await db
						.select({ id: labours.id, realmId: labours.realmId })
						.from(labours)
						.where(inArray(labours.id, event.data.labourIds))
				: [];
			const shown = new Set(rows.filter((row) => visible.has(row.realmId)).map((row) => row.id));
			return {
				...event,
				data: {
					quest: restrictQuest(event.data.quest, visible),
					labourIds: event.data.labourIds.filter((id) => shown.has(id))
				}
			} as SagasEvent;
		}
	}
}
