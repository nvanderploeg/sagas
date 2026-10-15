import { invalidate } from '$app/navigation';
import { PEOPLE, type Person } from './people.ts';

const asked = new Set<number>();
let pending: ReturnType<typeof setTimeout> | null = null;

// Users record no Events: when a view meets a User the directory lacks, load the directory
// again, once per such User and at most once per moment.
export function lookFor(ids: Iterable<number | null>, people: Map<number, Person>): void {
	let missing = false;
	for (const id of ids) {
		if (id === null || people.has(id) || asked.has(id)) continue;
		asked.add(id);
		missing = true;
	}
	if (!missing || pending !== null) return;
	pending = setTimeout(() => {
		pending = null;
		void invalidate(PEOPLE);
	}, 250);
}

export function usersOf(tickets: Iterable<{ ownerId: number; assigneeId: number | null }>) {
	const ids: number[] = [];
	for (const t of tickets) ids.push(t.ownerId, ...(t.assigneeId === null ? [] : [t.assigneeId]));
	return ids;
}
