import { asc, eq, gt, lt, lte, max, min } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { readSnapshot } from '#lib/server/db/tx.ts';
import { eventCounter, eventRealms, events, users } from '../db/schema.ts';
import type { SagasEvent } from './types.ts';
import { pruneDeliveries } from '../webhooks/deliveries.ts';

export async function eventsSince(
	db: Handle,
	seq: number,
	limit = 2 ** 31 - 1
): Promise<SagasEvent[]> {
	return (
		await db
			.select({
				seq: events.seq,
				type: events.type,
				actor: {
					id: users.id,
					kind: users.kind,
					username: users.username,
					displayName: users.displayName
				},
				tokenId: events.tokenId,
				tokenName: events.tokenName,
				createdAt: events.createdAt,
				data: events.data
			})
			.from(events)
			.innerJoin(users, eq(users.id, events.actorId))
			.where(gt(events.seq, seq))
			.orderBy(asc(events.seq))
			.limit(limit)
	).map(({ tokenId, tokenName, actor, ...rest }) => ({
		...rest,
		actor: { ...actor, via: tokenName === null ? null : { tokenId, name: tokenName } }
	})) as SagasEvent[];
}

export async function eventRealmIds(db: Handle, seq: number): Promise<number[]> {
	return (
		await db
			.select({ realmId: eventRealms.realmId })
			.from(eventRealms)
			.where(eq(eventRealms.seq, seq))
			.orderBy(asc(eventRealms.realmId))
	).map((row) => row.realmId);
}

// Read the seq in the view's transaction: a client drops every Event at or below it.
export async function readAtSeq<T>(
	db: Db,
	read: (tx: Handle) => T | Promise<T>
): Promise<{ seq: number; value: T }> {
	return readSnapshot(db, async (tx) => ({
		seq: (await eventWindow(tx)).last,
		value: await read(tx)
	}));
}

// `oldest` is the first seq still replayable; `last` the newest seq ever assigned, pruned or not.
export async function eventWindow(db: Handle): Promise<{ oldest: number; last: number }> {
	const last =
		(await db.select({ last: eventCounter.last }).from(eventCounter).limit(1))[0]?.last ?? 0;
	const oldest =
		(
			await db
				.select({ seq: min(events.seq) })
				.from(events)
				.limit(1)
		)[0]?.seq ?? last + 1;
	return { oldest, last };
}

export function canReplayFrom(window: { oldest: number; last: number }, since: number): boolean {
	return since + 1 >= window.oldest && since <= window.last;
}

// Cut by seq, never by timestamp alone: the retained Events must stay one contiguous seq range.
export async function pruneEvents(
	db: Handle,
	retentionMs: number,
	now = Date.now()
): Promise<number> {
	const cutoff = (
		await db
			.select({ seq: max(events.seq) })
			.from(events)
			.where(lt(events.createdAt, new Date(now - retentionMs)))
			.limit(1)
	)[0]?.seq;
	if (cutoff == null) return 0;
	return (await db.delete(events).where(lte(events.seq, cutoff))).rowCount ?? 0;
}

export async function schedulePruning(
	db: Handle,
	retentionMs: number,
	everyMs = 60 * 60 * 1000
): Promise<() => void> {
	const prune = async () => {
		try {
			await pruneEvents(db, retentionMs);
		} catch (error) {
			console.error('sagas event pruning failed', error);
		}
		try {
			await pruneDeliveries(db, retentionMs);
		} catch (error) {
			console.error('sagas delivery pruning failed', error);
		}
	};
	await prune();
	const timer = setInterval(prune, everyMs);
	timer.unref();
	return () => clearInterval(timer);
}
