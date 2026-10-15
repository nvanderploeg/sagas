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

type Draft = { card: Ticket; known: Set<number>; ticketId: number | null };

// Cards for Tickets still being created, each with a client id of its own. A draft gives way to
// the Ticket its create answered with. Before that answer, a new Ticket with its title in its
// State stands in for the oldest such draft only, so one Ticket never retires two drafts.
export class Drafts {
	#drafts: Draft[] = [];

	// `known` is every Ticket id the board holds as the draft is made.
	add(card: Ticket, known: Set<number>): (board: BoardView) => BoardView {
		const draft: Draft = { card, known, ticketId: null };
		this.#drafts.push(draft);
		return (board) => {
			if (this.#landed(board, draft)) return board;
			const column = columnOf(board, card.stateId);
			const rank = generateKeyBetween(column.at(-1)?.rank ?? null, null);
			return { ...board, tickets: [...board.tickets, { ...card, rank }] };
		};
	}

	answer(cardId: number, ticketId: number): void {
		const draft = this.#drafts.find((d) => d.card.id === cardId);
		if (!draft) return;
		draft.ticketId = ticketId;
		draft.known = new Set();
	}

	forget(cardId: number): void {
		this.#drafts = this.#drafts.filter((d) => d.card.id !== cardId);
	}

	#landed(board: BoardView, draft: Draft): boolean {
		if (draft.ticketId !== null) return board.tickets.some((t) => t.id === draft.ticketId);
		const alike = (d: Draft) =>
			d.ticketId === null &&
			d.card.stateId === draft.card.stateId &&
			d.card.title === draft.card.title;
		const claimed = new Set(this.#drafts.map((d) => d.ticketId));
		const fresh = board.tickets.filter(
			(t) =>
				t.id > 0 &&
				!draft.known.has(t.id) &&
				!claimed.has(t.id) &&
				t.stateId === draft.card.stateId &&
				t.title === draft.card.title
		);
		const ahead = this.#drafts.slice(0, this.#drafts.indexOf(draft)).filter(alike).length;
		return fresh.length > ahead;
	}
}
