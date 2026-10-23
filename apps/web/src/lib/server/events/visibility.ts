import { inArray, eq } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { labours, states } from '../db/schema.ts';
import { visibleRealmIds } from '../domain/access.ts';
import { restrictQuest } from '../domain/quest-view.ts';
import type { SagasEvent } from './types.ts';

function realmOfLabour(db: Handle, id: number): number | null {
	return (
		db.select({ realmId: labours.realmId }).from(labours).where(eq(labours.id, id)).get()
			?.realmId ?? null
	);
}

// The Event as one viewer may see it, or null when it concerns nothing they can see. Per
// docs/realm-access.md, membership is read now, not when the Event happened.
export function eventForViewer(
	db: Handle,
	event: SagasEvent,
	viewer: { id: number }
): SagasEvent | null {
	const ids = visibleRealmIds(db, viewer);
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
			const state = db
				.select({ realmId: states.realmId })
				.from(states)
				.where(eq(states.id, event.data.stateId))
				.get();
			return sees(state?.realmId ?? null) ? event : null;
		}
		case 'labour.rekeyed':
		case 'labour.deleted':
			return sees(event.data.realmId) ? event : null;
		case 'labour.commented':
		case 'labour.comment_edited':
			return sees(realmOfLabour(db, event.data.comment.labourId)) ? event : null;
		case 'labour.comment_deleted':
			return sees(realmOfLabour(db, event.data.labourId)) ? event : null;
		case 'quest.created':
		case 'quest.updated':
		case 'quest.labour_ranked':
			return {
				...event,
				data: { ...event.data, quest: restrictQuest(event.data.quest, visible) }
			} as SagasEvent;
		case 'quest.deleted':
			return event;
		case 'quest.labours_added':
		case 'quest.labours_removed': {
			const rows = event.data.labourIds.length
				? db
						.select({ id: labours.id, realmId: labours.realmId })
						.from(labours)
						.where(inArray(labours.id, event.data.labourIds))
						.all()
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
