import { and, asc, eq, or, sql } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { links } from '../db/schema.ts';
import { DomainError } from '../domain/errors.ts';
import { labourName } from '../domain/labour-view.ts';
import { getLabour } from '../domain/lookup.ts';
import type { Actor } from '../domain/write.ts';

export const LINK_TYPES = ['evidence', 'blocks', 'relates', 'duplicates'] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export type LinkView = {
	type: LinkType;
	from: number;
	to: number;
	note: string;
	setBy: number;
	setAt: Date;
};

export const LINK_NOTE_MAX = 500;

const typeOrder = sql`case ${links.type} when 'evidence' then 0 when 'blocks' then 1 when 'relates' then 2 else 3 end`;

export function readLinks(db: Handle, labourId: number): LinkView[] {
	return db
		.select()
		.from(links)
		.where(or(eq(links.fromId, labourId), eq(links.toId, labourId)))
		.orderBy(typeOrder, asc(links.fromId), asc(links.toId))
		.all()
		.map((row) => ({
			type: row.type,
			from: row.fromId,
			to: row.toId,
			note: row.note,
			setBy: row.setBy,
			setAt: row.setAt
		}));
}

function blocksReach(tx: Handle, start: number, target: number): boolean {
	const seen = new Set<number>([start]);
	const queue = [start];
	while (queue.length > 0) {
		const at = queue.shift()!;
		if (at === target) return true;
		const next = tx
			.select({ id: links.toId })
			.from(links)
			.where(and(eq(links.fromId, at), eq(links.type, 'blocks')))
			.all();
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
export function writeLink(tx: Handle, userId: number, change: LinkChange, now: Date): void {
	const { type, remove } = change;
	let { from, to } = change;
	if (type === 'relates' && from > to) [from, to] = [to, from];
	const match = and(eq(links.fromId, from), eq(links.toId, to), eq(links.type, type));

	if (remove) {
		tx.delete(links).where(match).run();
		return;
	}
	const existing = tx.select().from(links).where(match).get();
	if (existing === undefined && type === 'blocks' && blocksReach(tx, to, from)) {
		const name = labourName(tx);
		throw new DomainError(
			'conflict',
			`${name(from)} blocking ${name(to)} would create a cycle of blocks Links`
		);
	}
	const note = change.note ?? existing?.note ?? '';
	tx.insert(links)
		.values({ fromId: from, toId: to, type, note, setBy: userId, setAt: now })
		.onConflictDoUpdate({
			target: [links.fromId, links.toId, links.type],
			set: { note, setBy: userId, setAt: now }
		})
		.run();
}

export const LINK_BATCH_MAX = 50;

// All or nothing: one bad change refuses the batch.
export function changeLinks(
	db: Db,
	actor: Actor,
	changes: LinkChange[],
	now: Date = new Date()
): void {
	if (!Array.isArray(changes) || changes.length < 1 || changes.length > LINK_BATCH_MAX) {
		throw new DomainError('invalid', `Links take 1 to ${LINK_BATCH_MAX} changes`);
	}
	db.transaction((tx) => {
		for (const change of changes) {
			if (change.from === change.to) {
				throw new DomainError('invalid', 'A Labour cannot be linked to itself');
			}
			const note = change.note?.trim();
			if (note !== undefined && note.length > LINK_NOTE_MAX) {
				throw new DomainError('invalid', `A Link note must be at most ${LINK_NOTE_MAX} characters`);
			}
			getLabour(tx, change.from);
			getLabour(tx, change.to);
			writeLink(tx, actor.id, { ...change, note }, now);
		}
	});
}
