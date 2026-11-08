import { eq, inArray, sql } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { eventCounter, eventRealms, events, labours, users } from '../db/schema.ts';
import { publish } from '../events/bus.ts';
import type { EventActor, EventSpec, SagasEvent } from '../events/types.ts';
import { transact } from '#lib/server/db/tx.ts';

export type Actor = { id: number; via?: { tokenId: number; name: string } };

// Build the Events after the write's last change, so each carries the state as of the commit.
// List the write's own Event first, then one per side effect a client can see.
export type Outcome<T> = { value: T; events: EventSpec[] };

export async function write<T>(
	db: Db,
	actor: Actor,
	body: (tx: Handle) => Outcome<T> | Promise<Outcome<T>>
): Promise<T> {
	const { value, recorded } = await transact(db, async (tx) => {
		const outcome = await body(tx);
		return { value: outcome.value, recorded: await recordEvents(tx, actor, outcome.events) };
	});
	// Publish only after the commit: a listener must never see a write that rolled back.
	for (const event of recorded) publish(event);
	return value;
}

async function recordEvents(tx: Handle, actor: Actor, specs: EventSpec[]): Promise<SagasEvent[]> {
	if (specs.length === 0) return [];
	const by = await eventActor(tx, actor);
	const [counter] = await tx
		.update(eventCounter)
		.set({ last: sql`${eventCounter.last} + ${specs.length}` })
		.returning({ last: eventCounter.last });
	const first = counter.last - specs.length + 1;
	const recorded: SagasEvent[] = [];
	for (const [index, spec] of specs.entries()) {
		const [row] = await tx
			.insert(events)
			.values({
				seq: first + index,
				type: spec.type,
				actorId: by.id,
				tokenId: actor.via?.tokenId ?? null,
				tokenName: actor.via?.name ?? null,
				data: spec.data
			})
			.returning();
		const realmIds = [...new Set(spec.realms ?? (await touchedRealms(tx, spec)))];
		if (realmIds.length > 0) {
			await tx.insert(eventRealms).values(realmIds.map((realmId) => ({ seq: row.seq, realmId })));
		}
		recorded.push({
			seq: row.seq,
			type: row.type,
			actor: by,
			createdAt: row.createdAt,
			data: row.data
		} as SagasEvent);
	}
	return recorded;
}

// The rules are docs/webhooks.md "Realms an Event touches".
async function touchedRealms(tx: Handle, spec: EventSpec): Promise<number[]> {
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

async function labourRealms(tx: Handle, ids: number[]): Promise<number[]> {
	return (
		await tx
			.selectDistinct({ realmId: labours.realmId })
			.from(labours)
			.where(inArray(labours.id, ids))
	).map((row) => row.realmId);
}

async function eventActor(db: Handle, actor: Actor): Promise<EventActor> {
	const row = (
		await db
			.select({
				id: users.id,
				kind: users.kind,
				username: users.username,
				displayName: users.displayName
			})
			.from(users)
			.where(eq(users.id, actor.id))
			.limit(1)
	)[0];
	if (row === undefined) throw new Error(`Actor ${actor.id} does not exist`);
	return { ...row, via: actor.via ?? null };
}
