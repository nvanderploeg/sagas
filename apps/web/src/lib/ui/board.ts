import { generateKeyBetween } from 'fractional-indexing';
import { byRank } from '../live/apply.ts';
import type { BoardView, Labour } from '../live/types.ts';

export type Placement = 'top' | 'bottom' | { before: number } | { after: number };

// What the board shows: `null` is anyone, or any Label; `assignee: 'none'` is unassigned Labours
// only.
export type Filter = {
	owner: number | null;
	assignee: number | 'none' | null;
	label: string | null;
};

export const NO_FILTER: Filter = { owner: null, assignee: null, label: null };

export function matches(labour: Labour, filter: Filter): boolean {
	if (filter.owner !== null && labour.ownerId !== filter.owner) return false;
	if (filter.label !== null && !labour.labels.includes(filter.label)) return false;
	if (filter.assignee === 'none') return labour.assigneeId === null;
	return filter.assignee === null || labour.assigneeId === filter.assignee;
}

export function columnOf(board: BoardView, stateId: number): Labour[] {
	return board.labours.filter((t) => t.stateId === stateId).sort(byRank);
}

export function encodePlacement(placement: Placement): string {
	if (typeof placement === 'string') return placement;
	return 'before' in placement ? `before:${placement.before}` : `after:${placement.after}`;
}

// The placement that puts a card at `index` among the cards a person sees in a column.
export function placementAt(shown: Labour[], index: number): Placement {
	return index <= 0 || shown.length === 0
		? 'top'
		: { after: shown[Math.min(index, shown.length) - 1].id };
}

// The Rank the server gives; mirrors rankAt in lib/server/domain/rank.ts, so an optimistic card
// lands where the server puts it.
export function rankFor(
	column: Labour[],
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
		if (at < 0) throw new Error(`Labour ${anchor} is not in the column`);
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

// The board after moving a Labour, as the server will record it; null when nothing changes.
export function moveOnBoard(
	board: BoardView,
	labourId: number,
	stateId: number,
	placement: Placement
): BoardView | null {
	const labour = board.labours.find((t) => t.id === labourId);
	const state = board.realm.states.find((s) => s.id === stateId);
	if (!labour || !state) return null;
	const moving = labour.stateId !== stateId;
	const rank = rankFor(
		columnOf(board, stateId),
		{ id: labourId, rank: moving ? undefined : labour.rank },
		placement
	);
	if (!moving && rank === labour.rank) return null;
	const substateId = moving
		? state.substates.length > 0
			? state.defaultSubstateId
			: null
		: labour.substateId;
	return {
		...board,
		labours: board.labours.map((t) =>
			t.id === labourId ? { ...t, stateId, substateId, rank, closed: state.isClosed } : t
		)
	};
}

type Draft = { card: Labour; known: Set<number>; labourId: number | null };

// Cards for Labours still being created, each with a client id of its own. A draft gives way to
// the Labour its create answered with. Before that answer, a new Labour with its title in its
// State stands in for the oldest such draft only, so one Labour never retires two drafts.
export class Drafts {
	#drafts: Draft[] = [];

	// `known` is every Labour id the board holds as the draft is made.
	add(card: Labour, known: Set<number>): (board: BoardView) => BoardView {
		const draft: Draft = { card, known, labourId: null };
		this.#drafts.push(draft);
		return (board) => {
			if (this.#landed(board, draft)) return board;
			const column = columnOf(board, card.stateId);
			const rank = generateKeyBetween(column.at(-1)?.rank ?? null, null);
			return { ...board, labours: [...board.labours, { ...card, rank }] };
		};
	}

	answer(cardId: number, labourId: number): void {
		const draft = this.#drafts.find((d) => d.card.id === cardId);
		if (!draft) return;
		draft.labourId = labourId;
		draft.known = new Set();
	}

	forget(cardId: number): void {
		this.#drafts = this.#drafts.filter((d) => d.card.id !== cardId);
	}

	#landed(board: BoardView, draft: Draft): boolean {
		if (draft.labourId !== null) return board.labours.some((t) => t.id === draft.labourId);
		const alike = (d: Draft) =>
			d.labourId === null &&
			d.card.stateId === draft.card.stateId &&
			d.card.title === draft.card.title;
		const claimed = new Set(this.#drafts.map((d) => d.labourId));
		const fresh = board.labours.filter(
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
