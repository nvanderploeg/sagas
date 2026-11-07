import { requireRealmRole } from '../domain/access.ts';
import { currentVia } from '#lib/server/auth/via.ts';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { links } from '../db/schema.ts';
import { DomainError } from '../domain/errors.ts';
import { labourName } from '../domain/labour-view.ts';
import { getLabour } from '../domain/lookup.ts';
import type { Actor } from '../domain/write.ts';
import { transact } from '#lib/server/db/tx.ts';

export const LINK_TYPES = ['evidence', 'blocks', 'relates', 'duplicates'] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export type LinkView = {
	type: LinkType;
	from: number;
	to: number;
	note: string;
	setBy: number;
	via: string | null;
	setAt: Date;
};

export const LINK_NOTE_MAX = 500;

const typeOrder = sql`case ${links.type} when 'evidence' then 0 when 'blocks' then 1 when 'relates' then 2 else 3 end`;

export async function readLinks(db: Handle, labourId: number): Promise<LinkView[]> {
	return (
		await db
			.select()
			.from(links)
			.where(or(eq(links.fromId, labourId), eq(links.toId, labourId)))
			.orderBy(typeOrder, asc(links.fromId), asc(links.toId))
	).map((row) => ({
		type: row.type,
		from: row.fromId,
		to: row.toId,
		note: row.note,
		setBy: row.setBy,
		via: row.via,
		setAt: row.setAt
	}));
}

async function blocksReach(tx: Handle, start: number, target: number): Promise<boolean> {
	const seen = new Set<number>([start]);
	const queue = [start];
	while (queue.length > 0) {
		const at = queue.shift()!;
		if (at === target) return true;
		const next = await tx
			.select({ id: links.toId })
			.from(links)
			.where(and(eq(links.fromId, at), eq(links.type, 'blocks')));
		for (const { id } of next) {
			if (seen.has(id)) continue;
			seen.add(id);
			queue.push(id);
		}
	}
	return false;
}

export type LinkChange = {
	type: LinkType;
	from: number;
	to: number;
	// undefined keeps an existing note.
	note?: string;
	remove: boolean;
};

// Check `blocks` cycles through `tx`, so Links written earlier in the batch count.
export async function writeLink(
	tx: Handle,
	userId: number,
	change: LinkChange,
	now: Date
): Promise<void> {
	const { type, remove } = change;
	let { from, to } = change;
	if (type === 'relates' && from > to) [from, to] = [to, from];
	const match = and(eq(links.fromId, from), eq(links.toId, to), eq(links.type, type));

	if (remove) {
		await tx.delete(links).where(match);
		return;
	}
	const existing = (await tx.select().from(links).where(match).limit(1))[0];
	if (existing === undefined && type === 'blocks' && (await blocksReach(tx, to, from))) {
		const name = labourName(tx);
		throw new DomainError(
			'conflict',
			`${await name(from)} blocking ${await name(to)} would create a cycle of blocks Links`
		);
	}
	const note = change.note ?? existing?.note ?? '';
	await tx
		.insert(links)
		.values({ fromId: from, toId: to, type, note, setBy: userId, via: currentVia(), setAt: now })
		.onConflictDoUpdate({
			target: [links.fromId, links.toId, links.type],
			set: { note, setBy: userId, via: currentVia(), setAt: now }
		});
}

export const LINK_BATCH_MAX = 50;

// All or nothing: one bad change refuses the batch.
export async function changeLinks(
	db: Db,
	actor: Actor,
	changes: LinkChange[],
	now: Date = new Date()
): Promise<void> {
	if (!Array.isArray(changes) || changes.length < 1 || changes.length > LINK_BATCH_MAX) {
		throw new DomainError('invalid', `Links take 1 to ${LINK_BATCH_MAX} changes`);
	}
	await transact(db, async (tx) => {
		for (const change of changes) {
			if (change.from === change.to) {
				throw new DomainError('invalid', 'A Labour cannot be linked to itself');
			}
			const note = change.note?.trim();
			if (note !== undefined && note.length > LINK_NOTE_MAX) {
				throw new DomainError('invalid', `A Link note must be at most ${LINK_NOTE_MAX} characters`);
			}
			await requireRealmRole(tx, actor, (await getLabour(tx, change.from)).realmId, 'editor');
			await requireRealmRole(tx, actor, (await getLabour(tx, change.to)).realmId, 'viewer');
			await writeLink(tx, actor.id, { ...change, note }, now);
		}
	});
}
