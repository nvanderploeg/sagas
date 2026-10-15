import { asc, gt, lt, lte, max, min, sql } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { events } from '../db/schema.ts';
import type { WorkloadEvent } from './types.ts';

export function eventsSince(db: Handle, seq: number, limit = -1): WorkloadEvent[] {
	return db
		.select()
		.from(events)
		.where(gt(events.seq, seq))
		.orderBy(asc(events.seq))
		.limit(limit)
		.all();
}

// `oldest` is the first seq still replayable; `last` the newest seq ever assigned, pruned or not.
export function eventWindow(db: Handle): { oldest: number; last: number } {
	const last =
		db.get<{ seq: number } | undefined>(sql`SELECT seq FROM sqlite_sequence WHERE name = 'events'`)
			?.seq ?? 0;
	const oldest =
		db
			.select({ seq: min(events.seq) })
			.from(events)
			.get()?.seq ?? last + 1;
	return { oldest, last };
}

export function canReplayFrom(window: { oldest: number; last: number }, since: number): boolean {
	return since + 1 >= window.oldest && since <= window.last;
}

// Cut by seq, never by timestamp alone: the retained Events must stay one contiguous seq range.
export function pruneEvents(db: Handle, retentionMs: number, now = Date.now()): number {
	const cutoff = db
		.select({ seq: max(events.seq) })
		.from(events)
		.where(lt(events.createdAt, new Date(now - retentionMs)))
		.get()?.seq;
	if (cutoff == null) return 0;
	return db.delete(events).where(lte(events.seq, cutoff)).run().changes;
}

export function schedulePruning(
	db: Handle,
	retentionMs: number,
	everyMs = 60 * 60 * 1000
): () => void {
	const prune = () => {
		try {
			pruneEvents(db, retentionMs);
		} catch (error) {
			console.error('workload event pruning failed', error);
		}
	};
	prune();
	const timer = setInterval(prune, everyMs);
	timer.unref();
	return () => clearInterval(timer);
}
