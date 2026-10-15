import type { Db, Handle } from '../db/client.ts';
import { events } from '../db/schema.ts';
import { publish } from '../events/bus.ts';
import type { EntityIds, EventType, WorkloadEvent } from '../events/types.ts';

export type Actor = { id: number };

export type EventSpec = {
	type: EventType;
	entityIds: EntityIds;
	projectIds: Iterable<number | null | undefined>;
	snapshot: unknown;
};

// A write that changed nothing returns a null event and records none.
export type Outcome<T> = { value: T; event: EventSpec | null };

export function write<T>(db: Db, actor: Actor, body: (tx: Handle) => Outcome<T>): T {
	const recorded: WorkloadEvent[] = [];
	const value = db.transaction((tx) => {
		const outcome = body(tx);
		if (outcome.event) recorded.push(insertEvent(tx, actor, outcome.event));
		return outcome.value;
	});
	// Publish only after the commit: a listener must never see a write that rolled back.
	for (const event of recorded) publish(event);
	return value;
}

function insertEvent(tx: Handle, actor: Actor, spec: EventSpec): WorkloadEvent {
	const projectIds = [
		...new Set([...spec.projectIds].filter((id): id is number => typeof id === 'number'))
	].sort((a, b) => a - b);
	return tx
		.insert(events)
		.values({
			type: spec.type,
			entityIds: spec.entityIds,
			projectIds,
			actorId: actor.id,
			snapshot: spec.snapshot ?? null
		})
		.returning()
		.get();
}
