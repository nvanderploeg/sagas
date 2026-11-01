import { eq, inArray } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { eventRealms, events, labours, users } from '../db/schema.ts';
import { publish } from '../events/bus.ts';
import type { EventActor, EventSpec, SagasEvent } from '../events/types.ts';

export type Actor = { id: number; via?: { tokenId: number; name: string } };

// Build the Events after the write's last change, so each carries the state as of the commit.
// List the write's own Event first, then one per side effect a client can see.
export type Outcome<T> = { value: T; events: EventSpec[] };

export function write<T>(db: Db, actor: Actor, body: (tx: Handle) => Outcome<T>): T {
	const { value, recorded } = db.transaction((tx) => {
		const outcome = body(tx);
		return { value: outcome.value, recorded: recordEvents(tx, actor, outcome.events) };
	});
	// Publish only after the commit: a listener must never see a write that rolled back.
	for (const event of recorded) publish(event);
	return value;
}

function recordEvents(tx: Handle, actor: Actor, specs: EventSpec[]): SagasEvent[] {
	if (specs.length === 0) return [];
	const by = eventActor(tx, actor);
	return specs.map((spec) => {
		const row = tx
			.insert(events)
			.values({
				type: spec.type,
				actorId: by.id,
				tokenId: actor.via?.tokenId ?? null,
				tokenName: actor.via?.name ?? null,
				data: spec.data
			})
			.returning()
			.get();
		const realmIds = [...new Set(spec.realms ?? touchedRealms(tx, spec))];
		if (realmIds.length > 0) {
			tx.insert(eventRealms)
				.values(realmIds.map((realmId) => ({ seq: row.seq, realmId })))
				.run();
		}
		return {
			seq: row.seq,
			type: row.type,
			actor: by,
			createdAt: row.createdAt,
			data: row.data
		} as SagasEvent;
	});
}

// The rules are docs/webhooks.md "Realms an Event touches".
function touchedRealms(tx: Handle, spec: EventSpec): number[] {
	switch (spec.type) {
		case 'realm.created':
		case 'realm.updated':
		case 'state.created':
		case 'state.updated':
		case 'state.deleted':
		case 'substate.created':
		case 'substate.updated':
		case 'substate.deleted':
			return [spec.data.realm.id];
		case 'realm.deleted':
			return [spec.data.realmId];
		case 'labour.moved':
			return [spec.data.fromRealmId, spec.data.labour.realmId];
		case 'labour.created':
		case 'labour.updated':
		case 'labour.reparented':
			return [spec.data.labour.realmId];
		case 'labour.deleted':
		case 'labour.rekeyed':
		case 'scroll.deleted':
			return [spec.data.realmId];
		case 'labour.ranked':
			return labourRealms(tx, [spec.data.id]);
		case 'labour.commented':
		case 'labour.comment_edited':
			return labourRealms(tx, [spec.data.comment.labourId]);
		case 'labour.comment_deleted':
			return labourRealms(tx, [spec.data.labourId]);
		case 'quest.labours_added':
		case 'quest.labours_removed':
			return labourRealms(tx, spec.data.labourIds);
		case 'quest.created':
		case 'quest.deleted':
		case 'quest.updated':
		case 'quest.labour_ranked':
			return [];
		case 'scroll.created':
		case 'scroll.updated':
		case 'scroll.moved':
			return [spec.data.scroll.realmId];
	}
}

function labourRealms(tx: Handle, ids: number[]): number[] {
	return tx
		.selectDistinct({ realmId: labours.realmId })
		.from(labours)
		.where(inArray(labours.id, ids))
		.all()
		.map((row) => row.realmId);
}

function eventActor(db: Handle, actor: Actor): EventActor {
	const row = db
		.select({
			id: users.id,
			kind: users.kind,
			username: users.username,
			displayName: users.displayName
		})
		.from(users)
		.where(eq(users.id, actor.id))
		.get();
	if (row === undefined) throw new Error(`Actor ${actor.id} does not exist`);
	return { ...row, via: actor.via ?? null };
}
