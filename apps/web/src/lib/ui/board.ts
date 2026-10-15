import { generateKeyBetween } from 'fractional-indexing';
import { byRank } from '../live/apply.ts';
import type { BoardView, Ticket } from '../live/types.ts';

export type Placement = 'top' | 'bottom' | { before: number } | { after: number };

// Who the board shows: `null` is anyone; `assignee: 'none'` is unassigned Tickets only.
export type Filter = { owner: number | null; assignee: number | 'none' | null };

export const NO_FILTER: Filter = { owner: null, assignee: null };

export function matches(ticket: Ticket, filter: Filter): boolean {
	if (filter.owner !== null && ticket.ownerId !== filter.owner) return false;
	if (filter.assignee === 'none') return ticket.assigneeId === null;
	return filter.assignee === null || ticket.assigneeId === filter.assignee;
}

export function columnOf(board: BoardView, stateId: number): Ticket[] {
	return board.tickets.filter((t) => t.stateId === stateId).sort(byRank);
}

export function encodePlacement(placement: Placement): string {
	if (typeof placement === 'string') return placement;
	return 'before' in placement ? `before:${placement.before}` : `after:${placement.after}`;
}

// The placement that puts a card at `index` among the cards a person sees in a column.
export function placementAt(shown: Ticket[], index: number): Placement {
	return index <= 0 || shown.length === 0
		? 'top'
		: { after: shown[Math.min(index, shown.length) - 1].id };
}

// The Rank the server gives; mirrors rankAt in lib/server/domain/rank.ts, so an optimistic card
// lands where the server puts it.
export function rankFor(
	column: Ticket[],
	subject: { id: number; rank?: string },
	placement: Placement
): string {
	const others = column.filter((t) => t.id !== subject.id);
	let index: number;
	if (placement === 'top') index = 0;
	else if (placement === 'bottom') index = others.length;
	else {
		const anchor = 'before' in placement ? placement.before : placement.after;
		const at = others.findIndex((t) => t.id === anchor);
		if (at < 0) throw new Error(`Ticket ${anchor} is not in the column`);
		index = 'before' in placement ? at : at + 1;
	}
	const lo = others[index - 1]?.rank ?? null;
	const hi = others[index]?.rank ?? null;
	const current = subject.rank;
	if (current !== undefined && (lo === null || current > lo) && (hi === null || current < hi)) {
		return current;
	}
	return generateKeyBetween(lo, hi);
}

// The board after moving a Ticket, as the server will record it; null when nothing changes.
export function moveOnBoard(
	board: BoardView,
	ticketId: number,
	stateId: number,
	placement: Placement
): BoardView | null {
	const ticket = board.tickets.find((t) => t.id === ticketId);
	const state = board.project.states.find((s) => s.id === stateId);
	if (!ticket || !state) return null;
	const moving = ticket.stateId !== stateId;
	const rank = rankFor(
		columnOf(board, stateId),
		{ id: ticketId, rank: moving ? undefined : ticket.rank },
		placement
	);
	if (!moving && rank === ticket.rank) return null;
	const substateId = moving
		? state.substates.length > 0
			? state.defaultSubstateId
			: null
		: ticket.substateId;
	return {
		...board,
		tickets: board.tickets.map((t) =>
			t.id === ticketId ? { ...t, stateId, substateId, rank, closed: state.isClosed } : t
		)
	};
}

// A card for a Ticket still being created. It gives way to the real Ticket as soon as the board
// holds one it did not know of, with the same title in the same State.
export function createOnBoard(known: Set<number>, draft: Ticket): (board: BoardView) => BoardView {
	return (board) => {
		const landed = board.tickets.some(
			(t) => !known.has(t.id) && t.stateId === draft.stateId && t.title === draft.title.trim()
		);
		if (landed) return board;
		const column = columnOf(board, draft.stateId);
		const rank = generateKeyBetween(column.at(-1)?.rank ?? null, null);
		return { ...board, tickets: [...board.tickets, { ...draft, rank }] };
	};
}
