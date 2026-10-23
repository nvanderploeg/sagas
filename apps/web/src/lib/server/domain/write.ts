import { eq } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { events, users } from '../db/schema.ts';
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
		return {
			seq: row.seq,
			type: row.type,
			actor: by,
			createdAt: row.createdAt,
			data: row.data
		} as SagasEvent;
	});
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
