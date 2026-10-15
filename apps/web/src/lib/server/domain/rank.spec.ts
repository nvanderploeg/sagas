import { asc } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { events, labours } from '#lib/server/db/schema.ts';
import type { Actor } from './write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedRealm, seedLabour } from '#lib/server/test/fixtures.ts';
import { DomainError } from './errors.ts';
import { getLabour } from './lookup.ts';
import type { Placement } from './rank.ts';
import { createState, listStates } from './states.ts';
import { listColumn, moveLabour, rankLabour, updateLabour } from './labours.ts';

let db: Db;
let actor: Actor;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
});

afterEach(() => {
	db.$client.close();
});

const style = (key: string) => ({ key, label: key, color: '#000000', icon: 'dot' });

function expectDomainError(action: () => unknown, code: DomainError['code']) {
	let thrown: unknown;
	try {
		action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(DomainError);
	expect((thrown as DomainError).code).toBe(code);
}

function column(stateId: number): string[] {
	return listColumn(db, stateId).map((t) => t.title);
}

function seedColumn(...titles: string[]) {
	const realm = seedRealm(db, 'AM');
	const stateId = realm.initialStateId!;
	const byTitle = Object.fromEntries(
		titles.map((title) => [title, seedLabour(db, { realmId: realm.id, title })])
	);
	return { realm, stateId, byTitle };
}

describe('rankLabour', () => {
	it('places a Labour before or after another, or at the top or bottom of its State', () => {
		const { stateId, byTitle } = seedColumn('a', 'b', 'c');
		const { a, c } = byTitle;

		rankLabour(db, actor, c.id, { before: a.id });
		expect(column(stateId)).toEqual(['c', 'a', 'b']);

		rankLabour(db, actor, c.id, { after: a.id });
		expect(column(stateId)).toEqual(['a', 'c', 'b']);

		rankLabour(db, actor, a.id, 'bottom');
		expect(column(stateId)).toEqual(['c', 'b', 'a']);

		rankLabour(db, actor, a.id, 'top');
		expect(column(stateId)).toEqual(['a', 'c', 'b']);
	});

	it('writes only the ranked Labour row', () => {
		const { byTitle } = seedColumn('a', 'b', 'c', 'd');
		const all = () => db.select().from(labours).orderBy(asc(labours.id)).all();
		const before = all();

		rankLabour(db, actor, byTitle.d.id, { after: byTitle.a.id });

		const after = all();
		const changed = after.filter((row, i) => JSON.stringify(row) !== JSON.stringify(before[i]));
		expect(changed.map((row) => row.id)).toEqual([byTitle.d.id]);
		expect({ ...changed[0], rank: undefined }).toEqual({
			...before.find((row) => row.id === byTitle.d.id),
			rank: undefined
		});
	});

	it('records no Event and writes nothing when the Labour already sits there', () => {
		const { byTitle } = seedColumn('a', 'b');
		const seq = () => db.select().from(events).all().length;
		const count = seq();

		const same = rankLabour(db, actor, byTitle.b.id, { after: byTitle.a.id });

		expect(same.rank).toBe(byTitle.b.rank);
		expect(seq()).toBe(count);
	});

	it('refuses a Labour of another State, the Labour itself, and a malformed placement', () => {
		const { realm, byTitle } = seedColumn('a', 'b');
		const doing = createState(db, actor, realm.id, style('doing'));
		const elsewhere = seedLabour(db, { realmId: realm.id, stateId: doing.id });

		expectDomainError(
			() => rankLabour(db, actor, byTitle.a.id, { before: elsewhere.id }),
			'invalid'
		);
		expectDomainError(
			() => rankLabour(db, actor, byTitle.a.id, { after: byTitle.a.id }),
			'invalid'
		);
		expectDomainError(
			() => rankLabour(db, actor, byTitle.a.id, 'middle' as unknown as Placement),
			'invalid'
		);
		expect(getLabour(db, byTitle.a.id).rank).toBe(byTitle.a.rank);
	});

	it('names an anchor in another State by its key', () => {
		const { realm, byTitle } = seedColumn('a');
		const doing = createState(db, actor, realm.id, style('doing'));
		const elsewhere = seedLabour(db, { realmId: realm.id, stateId: doing.id });

		expect(() => rankLabour(db, actor, byTitle.a.id, { after: elsewhere.id })).toThrow(
			'AM-2 is not in the same State'
		);
	});
});

describe('rank key length', () => {
	const N = 400;
	const longest = (stateId: number) =>
		Math.max(...listColumn(db, stateId).map((t) => t.rank.length));

	// Fractional keys at one middle spot grow by about one character per 5 to 6 inserts; nothing
	// rebalances them.
	const MIDDLE_MIN = N / 8;
	const MIDDLE_MAX = N / 4;

	it(`grows linearly, within ${MIDDLE_MAX} characters, over ${N} inserts right after one Labour`, () => {
		const { realm, stateId, byTitle } = seedColumn('anchor', 'tail');
		for (let i = 0; i < N; i++) {
			seedLabour(db, {
				realmId: realm.id,
				title: `n${i}`,
				placement: { after: byTitle.anchor.id }
			});
		}

		const expected = ['anchor', ...Array.from({ length: N }, (_, i) => `n${N - 1 - i}`), 'tail'];
		expect(column(stateId)).toEqual(expected);
		expect(longest(stateId)).toBeGreaterThanOrEqual(MIDDLE_MIN);
		expect(longest(stateId)).toBeLessThanOrEqual(MIDDLE_MAX);
	});

	it(`grows linearly, within ${MIDDLE_MAX} characters, over ${N} inserts each right after the last`, () => {
		const { realm, stateId, byTitle } = seedColumn('head', 'tail');
		let previous = byTitle.head.id;
		for (let i = 0; i < N; i++) {
			previous = seedLabour(db, {
				realmId: realm.id,
				title: `n${i}`,
				placement: { after: previous }
			}).id;
		}

		const expected = ['head', ...Array.from({ length: N }, (_, i) => `n${i}`), 'tail'];
		expect(column(stateId)).toEqual(expected);
		expect(longest(stateId)).toBeGreaterThanOrEqual(MIDDLE_MIN);
		expect(longest(stateId)).toBeLessThanOrEqual(MIDDLE_MAX);
	});

	it(`stays within 4 characters over ${N} inserts at the top and ${N} at the bottom`, () => {
		const { realm, stateId } = seedColumn('middle');
		for (let i = 0; i < N; i++) {
			seedLabour(db, { realmId: realm.id, title: `top${i}`, placement: 'top' });
			seedLabour(db, { realmId: realm.id, title: `bottom${i}` });
		}

		const ranks = listColumn(db, stateId);
		expect(ranks[0].title).toBe(`top${N - 1}`);
		expect(ranks.at(-1)!.title).toBe(`bottom${N - 1}`);
		expect(longest(stateId)).toBeLessThanOrEqual(4);
	});
});

describe('default rank', () => {
	it('puts a created Labour at the bottom of its column, or where its placement says', () => {
		const { realm, stateId, byTitle } = seedColumn('a', 'b');
		rankLabour(db, actor, byTitle.b.id, 'top');

		seedLabour(db, { realmId: realm.id, title: 'c' });
		seedLabour(db, { realmId: realm.id, title: 'd', placement: { before: byTitle.a.id } });

		expect(column(stateId)).toEqual(['b', 'd', 'a', 'c']);
	});

	it('puts a Labour that changes State at the bottom of the new column without a placement', () => {
		const { realm, stateId, byTitle } = seedColumn('a', 'b');
		const doing = createState(db, actor, realm.id, style('doing'));
		const x = seedLabour(db, { realmId: realm.id, stateId: doing.id, title: 'x' });
		rankLabour(db, actor, x.id, 'top');

		updateLabour(db, actor, byTitle.a.id, { stateId: doing.id });
		updateLabour(db, actor, byTitle.b.id, { stateId: doing.id, placement: 'top' });

		expect(column(doing.id)).toEqual(['b', 'x', 'a']);
		expect(column(stateId)).toEqual([]);
	});

	it('keeps the rank when a Labour changes other fields, and reranks on a placement', () => {
		const { stateId, byTitle } = seedColumn('a', 'b');

		updateLabour(db, actor, byTitle.a.id, { title: 'a2', stateId });
		expect(column(stateId)).toEqual(['a2', 'b']);

		updateLabour(db, actor, byTitle.a.id, { placement: 'bottom' });
		expect(column(stateId)).toEqual(['b', 'a2']);
	});

	it('puts a Labour moved to another Realm at the bottom of its target column', () => {
		const { byTitle } = seedColumn('a');
		const bl = seedRealm(db, 'BL');
		seedLabour(db, { realmId: bl.id, title: 'x' });
		seedLabour(db, { realmId: bl.id, title: 'y' });
		const closed = listStates(db, bl.id).at(-1)!;
		seedLabour(db, { realmId: bl.id, title: 'z', stateId: closed.id });

		moveLabour(db, actor, byTitle.a.id, { realmId: bl.id });

		expect(column(bl.initialStateId!)).toEqual(['x', 'y', 'a']);
	});
});
