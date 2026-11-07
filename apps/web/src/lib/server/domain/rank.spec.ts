import { asc } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
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

beforeEach(async () => {
	db = await testDb();
	actor = await seedActor(db);
});

const style = (key: string) => ({ key, label: key, color: '#000000', icon: 'dot' });

async function expectDomainError(action: () => unknown, code: DomainError['code']) {
	let thrown: unknown;
	try {
		await action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(DomainError);
	expect((thrown as DomainError).code).toBe(code);
}

async function column(stateId: number): Promise<string[]> {
	return (await listColumn(db, stateId)).map((t) => t.title);
}

async function seedColumn(...titles: string[]) {
	const realm = await seedRealm(db, 'AM');
	const stateId = realm.initialStateId!;
	const byTitle = Object.fromEntries(
		await Promise.all(
			titles.map(async (title) => [title, await seedLabour(db, { realmId: realm.id, title })])
		)
	);
	return { realm, stateId, byTitle };
}

describe('rankLabour', () => {
	it('places a Labour before or after another, or at the top or bottom of its State', async () => {
		const { stateId, byTitle } = await seedColumn('a', 'b', 'c');
		const { a, c } = byTitle;

		await rankLabour(db, actor, c.id, { before: a.id });
		expect(await column(stateId)).toEqual(['c', 'a', 'b']);

		await rankLabour(db, actor, c.id, { after: a.id });
		expect(await column(stateId)).toEqual(['a', 'c', 'b']);

		await rankLabour(db, actor, a.id, 'bottom');
		expect(await column(stateId)).toEqual(['c', 'b', 'a']);

		await rankLabour(db, actor, a.id, 'top');
		expect(await column(stateId)).toEqual(['a', 'c', 'b']);
	});

	it('writes only the ranked Labour row', async () => {
		const { byTitle } = await seedColumn('a', 'b', 'c', 'd');
		const all = async () => await db.select().from(labours).orderBy(asc(labours.id));
		const before = await all();

		await rankLabour(db, actor, byTitle.d.id, { after: byTitle.a.id });

		const after = await all();
		const changed = after.filter((row, i) => JSON.stringify(row) !== JSON.stringify(before[i]));
		expect(changed.map((row) => row.id)).toEqual([byTitle.d.id]);
		expect({ ...changed[0], rank: undefined }).toEqual({
			...before.find((row) => row.id === byTitle.d.id),
			rank: undefined
		});
	});

	it('records no Event and writes nothing when the Labour already sits there', async () => {
		const { byTitle } = await seedColumn('a', 'b');
		const seq = async () => (await db.select().from(events)).length;
		const count = await seq();

		const same = await rankLabour(db, actor, byTitle.b.id, { after: byTitle.a.id });

		expect(same.rank).toBe(byTitle.b.rank);
		expect(await seq()).toBe(count);
	});

	it('refuses a Labour of another State, the Labour itself, and a malformed placement', async () => {
		const { realm, byTitle } = await seedColumn('a', 'b');
		const doing = await createState(db, actor, realm.id, style('doing'));
		const elsewhere = await seedLabour(db, { realmId: realm.id, stateId: doing.id });

		await expectDomainError(
			() => rankLabour(db, actor, byTitle.a.id, { before: elsewhere.id }),
			'invalid'
		);
		await expectDomainError(
			() => rankLabour(db, actor, byTitle.a.id, { after: byTitle.a.id }),
			'invalid'
		);
		await expectDomainError(
			() => rankLabour(db, actor, byTitle.a.id, 'middle' as unknown as Placement),
			'invalid'
		);
		expect((await getLabour(db, byTitle.a.id)).rank).toBe(byTitle.a.rank);
	});

	it('names an anchor in another State by its key', async () => {
		const { realm, byTitle } = await seedColumn('a');
		const doing = await createState(db, actor, realm.id, style('doing'));
		const elsewhere = await seedLabour(db, { realmId: realm.id, stateId: doing.id });

		await expect(rankLabour(db, actor, byTitle.a.id, { after: elsewhere.id })).rejects.toThrow(
			'AM-2 is not in the same State'
		);
	});
});

describe('rank key length', { timeout: 60_000 }, () => {
	const N = 400;
	const longest = async (stateId: number) =>
		Math.max(...(await listColumn(db, stateId)).map((t) => t.rank.length));

	// Fractional keys at one middle spot grow by about one character per 5 to 6 inserts; nothing
	// rebalances them.
	const MIDDLE_MIN = N / 8;
	const MIDDLE_MAX = N / 4;

	it(`grows linearly, within ${MIDDLE_MAX} characters, over ${N} inserts right after one Labour`, async () => {
		const { realm, stateId, byTitle } = await seedColumn('anchor', 'tail');
		for (let i = 0; i < N; i++) {
			await seedLabour(db, {
				realmId: realm.id,
				title: `n${i}`,
				placement: { after: byTitle.anchor.id }
			});
		}

		const expected = ['anchor', ...Array.from({ length: N }, (_, i) => `n${N - 1 - i}`), 'tail'];
		expect(await column(stateId)).toEqual(expected);
		expect(await longest(stateId)).toBeGreaterThanOrEqual(MIDDLE_MIN);
		expect(await longest(stateId)).toBeLessThanOrEqual(MIDDLE_MAX);
	});

	it(`grows linearly, within ${MIDDLE_MAX} characters, over ${N} inserts each right after the last`, async () => {
		const { realm, stateId, byTitle } = await seedColumn('head', 'tail');
		let previous = byTitle.head.id;
		for (let i = 0; i < N; i++) {
			previous = (
				await seedLabour(db, {
					realmId: realm.id,
					title: `n${i}`,
					placement: { after: previous }
				})
			).id;
		}

		const expected = ['head', ...Array.from({ length: N }, (_, i) => `n${i}`), 'tail'];
		expect(await column(stateId)).toEqual(expected);
		expect(await longest(stateId)).toBeGreaterThanOrEqual(MIDDLE_MIN);
		expect(await longest(stateId)).toBeLessThanOrEqual(MIDDLE_MAX);
	});

	it(`stays within 4 characters over ${N} inserts at the top and ${N} at the bottom`, async () => {
		const { realm, stateId } = await seedColumn('middle');
		for (let i = 0; i < N; i++) {
			await seedLabour(db, { realmId: realm.id, title: `top${i}`, placement: 'top' });
			await seedLabour(db, { realmId: realm.id, title: `bottom${i}` });
		}

		const ranks = await listColumn(db, stateId);
		expect(ranks[0].title).toBe(`top${N - 1}`);
		expect(ranks.at(-1)!.title).toBe(`bottom${N - 1}`);
		expect(await longest(stateId)).toBeLessThanOrEqual(4);
	});
});

describe('default rank', () => {
	it('puts a created Labour at the bottom of its column, or where its placement says', async () => {
		const { realm, stateId, byTitle } = await seedColumn('a', 'b');
		await rankLabour(db, actor, byTitle.b.id, 'top');

		await seedLabour(db, { realmId: realm.id, title: 'c' });
		await seedLabour(db, { realmId: realm.id, title: 'd', placement: { before: byTitle.a.id } });

		expect(await column(stateId)).toEqual(['b', 'd', 'a', 'c']);
	});

	it('puts a Labour that changes State at the bottom of the new column without a placement', async () => {
		const { realm, stateId, byTitle } = await seedColumn('a', 'b');
		const doing = await createState(db, actor, realm.id, style('doing'));
		const x = await seedLabour(db, { realmId: realm.id, stateId: doing.id, title: 'x' });
		await rankLabour(db, actor, x.id, 'top');

		await updateLabour(db, actor, byTitle.a.id, { stateId: doing.id });
		await updateLabour(db, actor, byTitle.b.id, { stateId: doing.id, placement: 'top' });

		expect(await column(doing.id)).toEqual(['b', 'x', 'a']);
		expect(await column(stateId)).toEqual([]);
	});

	it('keeps the rank when a Labour changes other fields, and reranks on a placement', async () => {
		const { stateId, byTitle } = await seedColumn('a', 'b');

		await updateLabour(db, actor, byTitle.a.id, { title: 'a2', stateId });
		expect(await column(stateId)).toEqual(['a2', 'b']);

		await updateLabour(db, actor, byTitle.a.id, { placement: 'bottom' });
		expect(await column(stateId)).toEqual(['b', 'a2']);
	});

	it('puts a Labour moved to another Realm at the bottom of its target column', async () => {
		const { byTitle } = await seedColumn('a');
		const bl = await seedRealm(db, 'BL');
		await seedLabour(db, { realmId: bl.id, title: 'x' });
		await seedLabour(db, { realmId: bl.id, title: 'y' });
		const closed = (await listStates(db, bl.id)).at(-1)!;
		await seedLabour(db, { realmId: bl.id, title: 'z', stateId: closed.id });

		await moveLabour(db, actor, byTitle.a.id, { realmId: bl.id });

		expect(await column(bl.initialStateId!)).toEqual(['x', 'y', 'a']);
	});
});
