import { generateKeyBetween } from 'fractional-indexing';
import { DomainError } from './errors.ts';

export type Placement = 'top' | 'bottom' | { before: number } | { after: number };

type Entry = { id: number; rank: string };

// Ranks compare by code unit, as SQLite's default BINARY collation does.
export function rankAt(
	column: Entry[],
	subject: { id: number | null; rank?: string },
	placement: Placement,
	scope: 'State' | 'Quest'
): string {
	const others = column.filter((entry) => entry.id !== subject.id);
	const index = insertionIndex(others, subject.id, placement, scope);
	const lo = others[index - 1]?.rank ?? null;
	const hi = others[index]?.rank ?? null;
	const current = subject.rank;
	if (current !== undefined && (lo === null || current > lo) && (hi === null || current < hi)) {
		return current;
	}
	return generateKeyBetween(lo, hi);
}

function insertionIndex(
	others: Entry[],
	subjectId: number | null,
	placement: Placement,
	scope: string
): number {
	if (placement === 'top') return 0;
	if (placement === 'bottom') return others.length;
	if (typeof placement === 'object' && placement !== null) {
		const before = 'before' in placement;
		const anchor = before ? placement.before : 'after' in placement ? placement.after : undefined;
		if (typeof anchor === 'number') {
			if (anchor === subjectId) {
				throw new DomainError('invalid', 'A Ticket cannot be placed relative to itself');
			}
			const at = others.findIndex((entry) => entry.id === anchor);
			if (at < 0) throw new DomainError('invalid', `Ticket ${anchor} is not in the same ${scope}`);
			return before ? at : at + 1;
		}
	}
	throw new DomainError('invalid', 'Placement must be top, bottom, or before or after a Ticket');
}
