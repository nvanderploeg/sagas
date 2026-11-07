import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { readBoard } from '#lib/server/domain/realms.ts';
import { rankLabour, updateLabour } from '#lib/server/domain/labours.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedRealm, seedLabour } from '#lib/server/test/fixtures.ts';
import { toJson } from '#lib/server/ui/reads.ts';
import { byRank } from '../live/apply.ts';
import type { BoardView, Labour } from '../live/types.ts';
import { Drafts, matches, moveOnBoard, NO_FILTER, placementAt, type Placement } from './board.ts';

let db: Db;
let actor: Actor;

beforeEach(async () => {
	db = await testDb();
	actor = await seedActor(db);
});

const order = (board: BoardView, stateId: number) =>
	board.labours
		.filter((t) => t.stateId === stateId)
		.sort(byRank)
		.map((t) => t.id);

describe('moveOnBoard', () => {
	it('predicts the Rank and State the server records', async () => {
		const realm = await seedRealm(db);
		const ids = await Promise.all(
			Array.from(
				{ length: 5 },
				async () => (await seedLabour(db, { realmId: realm.id, ownerId: actor.id })).id
			)
		);
		const board = async () => toJson(await readBoard(db, realm.id)) as BoardView;
		const open = realm.initialStateId!;
		const closed = (await board()).realm.states.find((s) => s.isClosed)!.id;

		const moves: [number, number, Placement][] = [
			[ids[4], open, 'top'],
			[ids[0], open, { after: ids[2] }],
			[ids[1], closed, 'top'],
			[ids[3], closed, { after: ids[1] }],
			[ids[2], open, 'bottom'],
			[ids[1], open, { before: ids[4] }]
		];
		for (const [id, stateId, placement] of moves) {
			const before = await board();
			const predicted = moveOnBoard(before, id, stateId, placement)!;
			const current = before.labours.find((t) => t.id === id)!;
			if (current.stateId === stateId) await rankLabour(db, actor, id, placement);
			else await updateLabour(db, actor, id, { stateId, placement });
			const after = await board();
			const pick = (b: BoardView) => b.labours.find((t) => t.id === id)!;
			expect(pick(predicted)).toMatchObject({
				stateId,
				rank: pick(after).rank,
				closed: pick(after).closed,
				substateId: pick(after).substateId
			});
			expect(order(predicted, stateId)).toEqual(order(after, stateId));
		}
	});

	it('is null for a drop back where the card was', async () => {
		const realm = await seedRealm(db);
		const a = await seedLabour(db, { realmId: realm.id });
		const b = await seedLabour(db, { realmId: realm.id });
		const board = toJson(await readBoard(db, realm.id)) as BoardView;
		expect(moveOnBoard(board, b.id, b.stateId, { after: a.id })).toBeNull();
	});
});

describe('placementAt', () => {
	const t = (id: number) => ({ id }) as Labour;
	it('places at the top, or after the card above the drop', () => {
		expect(placementAt([], 0)).toBe('top');
		expect(placementAt([t(4), t(7)], 0)).toBe('top');
		expect(placementAt([t(4), t(7)], 1)).toEqual({ after: 4 });
		expect(placementAt([t(4), t(7)], 2)).toEqual({ after: 7 });
	});
});

describe('Drafts', () => {
	it('shows a draft card until its Labour arrives, and never both', async () => {
		const realm = await seedRealm(db);
		await seedLabour(db, { realmId: realm.id, title: 'Existing' });
		const loaded = toJson(await readBoard(db, realm.id)) as BoardView;
		const card = { ...loaded.labours[0], id: -1, title: 'Fresh', key: '' };
		const drafts = new Drafts();
		const patch = drafts.add(card, new Set(loaded.labours.map((t) => t.id)));

		expect(patch(loaded).labours.map((t) => t.title)).toEqual(['Existing', 'Fresh']);

		const created = await seedLabour(db, { realmId: realm.id, title: 'Fresh' });
		const arrived = toJson(await readBoard(db, realm.id)) as BoardView;
		expect(patch(arrived).labours.map((t) => t.id)).toEqual(arrived.labours.map((t) => t.id));
		drafts.answer(-1, created.id);
		expect(patch(arrived).labours.map((t) => t.id)).toEqual(arrived.labours.map((t) => t.id));
	});

	it('gives way only to the Labour its create answered with, once it has answered', async () => {
		const realm = await seedRealm(db);
		const stateId = realm.initialStateId!;
		const drafts = new Drafts();
		const patch = drafts.add({ ...({} as Labour), id: -1, stateId, title: 'Mine' }, new Set());
		drafts.answer(-1, 999);

		const other = await seedLabour(db, { realmId: realm.id, title: 'Mine' });
		const board = toJson(await readBoard(db, realm.id)) as BoardView;
		expect(patch(board).labours.map((t) => t.id)).toEqual([other.id, -1]);
	});

	it('gives each of two drafts with the same title a Labour of its own', async () => {
		const realm = await seedRealm(db);
		const loaded = toJson(await readBoard(db, realm.id)) as BoardView;
		const stateId = realm.initialStateId!;
		const base = { ...({} as Labour), stateId, title: 'Same', key: '', rank: '' };
		const drafts = new Drafts();
		const patches = [-1, -2].map((id) => drafts.add({ ...base, id }, new Set()));
		const shown = (board: BoardView) =>
			patches.reduce((view, patch) => patch(view), board).labours.map((t) => t.id);

		expect(shown(loaded)).toEqual([-1, -2]);
		const first = await seedLabour(db, { realmId: realm.id, title: 'Same' });
		const one = toJson(await readBoard(db, realm.id)) as BoardView;
		expect(shown(one)).toEqual([first.id, -2]);

		drafts.answer(-2, first.id);
		expect(shown(one)).toEqual([first.id, -1]);
		const second = await seedLabour(db, { realmId: realm.id, title: 'Same' });
		drafts.answer(-1, second.id);
		const both = toJson(await readBoard(db, realm.id)) as BoardView;
		expect(shown(both)).toEqual([first.id, second.id]);
	});
});

describe('matches', () => {
	const labour = { ownerId: 1, assigneeId: 2, labels: ['bug'] } as Labour;
	it('filters by owner and by assignee', () => {
		expect(matches(labour, NO_FILTER)).toBe(true);
		expect(matches(labour, { ...NO_FILTER, owner: 1, assignee: 2 })).toBe(true);
		expect(matches(labour, { ...NO_FILTER, owner: 3 })).toBe(false);
		expect(matches(labour, { ...NO_FILTER, assignee: 'none' })).toBe(false);
		expect(matches({ ...labour, assigneeId: null }, { ...NO_FILTER, assignee: 'none' })).toBe(true);
	});

	it('filters by Label', () => {
		expect(matches(labour, { ...NO_FILTER, label: 'bug' })).toBe(true);
		expect(matches(labour, { ...NO_FILTER, label: 'wayfinder:map' })).toBe(false);
	});
});
