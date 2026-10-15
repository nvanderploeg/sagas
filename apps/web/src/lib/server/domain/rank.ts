import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { DomainError } from './errors.ts';

export type Placement = 'top' | 'bottom' | { before: number } | { after: number };

type Entry = { id: number; rank: string };

export type NameLabour = (id: number) => string;

const byId: NameLabour = (id) => `Labour ${id}`;

// Ranks compare by code unit, as SQLite's default BINARY collation does.
export function rankAt(
	column: Entry[],
	subject: { id: number | null; rank?: string },
	placement: Placement,
	scope: 'State' | 'Quest',
	name: NameLabour = byId
): string {
	const others = column.filter((entry) => entry.id !== subject.id);
	const index = insertionIndex(others, subject.id, placement, scope, name);
	const lo = others[index - 1]?.rank ?? null;
	const hi = others[index]?.rank ?? null;
	const current = subject.rank;
	if (current !== undefined && (lo === null || current > lo) && (hi === null || current < hi)) {
		return current;
	}
	return generateKeyBetween(lo, hi);
}

// Ranks for `count` new entries placed together, in order.
export function ranksAt(
	column: Entry[],
	placement: Placement,
	scope: 'State' | 'Quest',
	count: number,
	name: NameLabour = byId
): string[] {
	const index = insertionIndex(column, null, placement, scope, name);
	return generateNKeysBetween(column[index - 1]?.rank ?? null, column[index]?.rank ?? null, count);
}

function insertionIndex(
	others: Entry[],
	subjectId: number | null,
	placement: Placement,
	scope: string,
	name: NameLabour
): number {
	if (placement === 'top') return 0;
	if (placement === 'bottom') return others.length;
	if (typeof placement === 'object' && placement !== null) {
		const before = 'before' in placement;
		const anchor = before ? placement.before : 'after' in placement ? placement.after : undefined;
		if (typeof anchor === 'number') {
			if (anchor === subjectId) {
				throw new DomainError('invalid', 'A Labour cannot be placed relative to itself');
			}
			const at = others.findIndex((entry) => entry.id === anchor);
			if (at < 0) throw new DomainError('invalid', `${name(anchor)} is not in the same ${scope}`);
			return before ? at : at + 1;
		}
	}
	throw new DomainError('invalid', 'Placement must be top, bottom, or before or after a Labour');
}
