import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { deleteLabour, moveLabour } from '#lib/server/domain/labours.ts';
import { deleteRealm } from '#lib/server/domain/realms.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import { appraise, readAppraisal, type AppraiseItem } from './appraisals.ts';
import { readLinks, type LinkType, type LinkView } from './links.ts';

let db: Db;
let actor: Actor;
let other: Actor;
let am: { id: number };
let bl: { id: number };

beforeEach(async () => {
	db = await testDb();
	actor = await seedActor(db);
	other = { id: await seedUser(db, 'other') };
	am = await seedRealm(db, 'AM');
	bl = await seedRealm(db, 'BL');
});

const day = (n: number) => new Date(Date.UTC(2030, 0, n));

async function expectDomainError(
	action: () => unknown,
	code: DomainError['code']
): Promise<DomainError> {
	let thrown: unknown;
	try {
		await action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(DomainError);
	expect((thrown as DomainError).code).toBe(code);
	return thrown as DomainError;
}

const mk = async (realm: { id: number } = am) => (await seedLabour(db, { realmId: realm.id })).id;

type Entry = NonNullable<AppraiseItem['links']>[number];

const link = (labourId: number, entry: Entry, now = day(2), by = actor) =>
	appraise(db, by, [{ labourId, links: [entry] }], now);

const edges = (links: LinkView[]) => links.map((l) => [l.type, l.from, l.to]);

describe('Link direction', () => {
	it.each<LinkType>(['evidence', 'blocks', 'duplicates'])(
		'makes the appraised Labour the from end of a %s Link named with to',
		async (type) => {
			const [a, b] = [await mk(), await mk()];

			await link(a, { type, to: b });

			expect(edges(await readLinks(db, a))).toEqual([[type, a, b]]);
		}
	);

	it.each<LinkType>(['evidence', 'blocks', 'duplicates'])(
		'makes the appraised Labour the to end of a %s Link named with from',
		async (type) => {
			const [a, b] = [await mk(), await mk()];

			await link(a, { type, from: b });

			expect(edges(await readLinks(db, a))).toEqual([[type, b, a]]);
		}
	);

	it('stores the same Link whichever Labour names the other', async () => {
		const [a, b] = [await mk(), await mk()];

		await link(a, { type: 'evidence', to: b });
		await link(b, { type: 'evidence', from: a });

		expect(await readLinks(db, a)).toHaveLength(1);
	});

	it('keeps evidence in opposite directions as two Links', async () => {
		const [a, b] = [await mk(), await mk()];

		await link(a, { type: 'evidence', to: b });
		await link(b, { type: 'evidence', to: a });

		expect(edges(await readLinks(db, a))).toEqual([
			['evidence', a, b],
			['evidence', b, a]
		]);
	});

	it('keeps duplicates in opposite directions as two Links', async () => {
		const [a, b] = [await mk(), await mk()];

		await link(a, { type: 'duplicates', to: b });
		await link(b, { type: 'duplicates', to: a });

		expect(await readLinks(db, a)).toHaveLength(2);
	});

	it('keeps Links of different types between the same pair', async () => {
		const [a, b] = [await mk(), await mk()];

		await link(a, { type: 'evidence', to: b });
		await link(a, { type: 'blocks', to: b });
		await link(a, { type: 'relates', to: b });
		await link(a, { type: 'duplicates', to: b });

		expect((await readLinks(db, a)).map((l) => l.type)).toEqual([
			'evidence',
			'blocks',
			'relates',
			'duplicates'
		]);
	});

	it('adds one Link for the same (from, to, type) however often it is added', async () => {
		const [a, b] = [await mk(), await mk()];

		await link(a, { type: 'blocks', to: b });
		await link(a, { type: 'blocks', to: b });
		await link(b, { type: 'blocks', from: a });

		expect(await readLinks(db, a)).toHaveLength(1);
	});
});

describe('relates', () => {
	it('is stored with the lower id as from when the higher id names the lower with to', async () => {
		const [low, high] = [await mk(), await mk()];

		await link(high, { type: 'relates', to: low });

		expect(edges(await readLinks(db, low))).toEqual([['relates', low, high]]);
	});

	it('is stored with the lower id as from when the higher id names the lower with from', async () => {
		const [low, high] = [await mk(), await mk()];

		await link(high, { type: 'relates', from: low });

		expect(edges(await readLinks(db, low))).toEqual([['relates', low, high]]);
	});

	it('is stored with the lower id as from when the lower id names the higher', async () => {
		const [low, high] = [await mk(), await mk()];

		await link(low, { type: 'relates', to: high });
		expect(edges(await readLinks(db, high))).toEqual([['relates', low, high]]);
		await link(low, { type: 'relates', from: high });
		expect(edges(await readLinks(db, high))).toEqual([['relates', low, high]]);
	});

	it('is one Link however the two Labours name each other', async () => {
		const [low, high] = [await mk(), await mk()];

		await link(low, { type: 'relates', to: high });
		await link(high, { type: 'relates', to: low });
		await link(low, { type: 'relates', from: high });
		await link(high, { type: 'relates', from: low });

		expect(await readLinks(db, low)).toHaveLength(1);
	});

	it('is re-noted from the other end', async () => {
		const [low, high] = [await mk(), await mk()];
		await link(low, { type: 'relates', to: high, note: 'first' });

		await link(high, { type: 'relates', to: low, note: 'second' });

		expect(await readLinks(db, low)).toMatchObject([{ note: 'second' }]);
	});

	it('is removed from either end', async () => {
		const [low, high] = [await mk(), await mk()];

		await link(low, { type: 'relates', to: high });
		await link(high, { type: 'relates', to: low, remove: true });
		expect(await readLinks(db, low)).toEqual([]);

		await link(low, { type: 'relates', to: high });
		await link(low, { type: 'relates', from: high, remove: true });
		expect(await readLinks(db, low)).toEqual([]);
	});

	it('does not stop a pair relating while a directed Link of another type stands', async () => {
		const [a, b] = [await mk(), await mk()];
		await link(a, { type: 'blocks', to: b });

		await link(b, { type: 'relates', to: a });

		expect((await readLinks(db, a)).map((l) => l.type)).toEqual(['blocks', 'relates']);
	});
});

describe('readLinks', () => {
	it('is empty for a Labour with no Links', async () => {
		expect(await readLinks(db, await mk())).toEqual([]);
	});

	it('returns each Link in full', async () => {
		const [a, b] = [await mk(), await mk()];

		await link(a, { type: 'evidence', to: b, note: 'logs show it' }, day(3), other);

		expect(await readLinks(db, a)).toEqual([
			{
				type: 'evidence',
				from: a,
				to: b,
				note: 'logs show it',
				setBy: other.id,
				via: null,
				setAt: day(3)
			}
		]);
	});

	it('returns a Link from both its ends', async () => {
		const [a, b] = [await mk(), await mk()];
		await link(a, { type: 'duplicates', to: b });

		expect(await readLinks(db, b)).toEqual(await readLinks(db, a));
		expect(await readLinks(db, b)).toHaveLength(1);
	});

	it('orders by type, then from, then to', async () => {
		const [a, b, c, d] = [await mk(), await mk(), await mk(), await mk()];
		await link(b, { type: 'duplicates', to: d });
		await link(c, { type: 'evidence', to: b });
		await link(b, { type: 'relates', to: c });
		await link(a, { type: 'blocks', to: b });
		await link(b, { type: 'evidence', to: c });
		await link(b, { type: 'blocks', to: d });
		await link(a, { type: 'relates', to: b });
		await link(a, { type: 'evidence', to: b });

		expect(edges(await readLinks(db, b))).toEqual([
			['evidence', a, b],
			['evidence', b, c],
			['evidence', c, b],
			['blocks', a, b],
			['blocks', b, d],
			['relates', a, b],
			['relates', b, c],
			['duplicates', b, d]
		]);
	});

	it('does not include Links between other Labours', async () => {
		const [a, b, c] = [await mk(), await mk(), await mk()];
		await link(b, { type: 'evidence', to: c });

		expect(await readLinks(db, a)).toEqual([]);
	});
});

describe('Link notes', () => {
	it('is empty when a new Link is added without one', async () => {
		const [a, b] = [await mk(), await mk()];

		await link(a, { type: 'evidence', to: b });

		expect((await readLinks(db, a))[0].note).toBe('');
	});

	it('is stored trimmed', async () => {
		const [a, b] = [await mk(), await mk()];

		await link(a, { type: 'evidence', to: b, note: '  spaced out \n' });

		expect((await readLinks(db, a))[0].note).toBe('spaced out');
	});

	it('accepts 500 characters and refuses 501 as invalid', async () => {
		const [a, b] = [await mk(), await mk()];

		await link(a, { type: 'evidence', to: b, note: 'n'.repeat(500) });
		expect((await readLinks(db, a))[0].note).toHaveLength(500);

		await expectDomainError(
			() => link(a, { type: 'evidence', to: b, note: 'n'.repeat(501) }),
			'invalid'
		);
		expect((await readLinks(db, a))[0].note).toHaveLength(500);
	});

	it('refuses an over-long note on a new Link without adding it', async () => {
		const [a, b] = [await mk(), await mk()];

		await expectDomainError(
			() => link(a, { type: 'blocks', to: b, note: 'n'.repeat(501) }),
			'invalid'
		);

		expect(await readLinks(db, a)).toEqual([]);
	});

	it('replaces the note of an existing Link when a note is given', async () => {
		const [a, b] = [await mk(), await mk()];
		await link(a, { type: 'evidence', to: b, note: 'old' });

		await link(a, { type: 'evidence', to: b, note: 'new' });

		expect(await readLinks(db, a)).toMatchObject([{ note: 'new' }]);
	});

	it('clears the note of an existing Link when an empty note is given', async () => {
		const [a, b] = [await mk(), await mk()];
		await link(a, { type: 'evidence', to: b, note: 'old' });

		await link(a, { type: 'evidence', to: b, note: '' });

		expect((await readLinks(db, a))[0].note).toBe('');
	});

	it('keeps the note of an existing Link when none is given', async () => {
		const [a, b] = [await mk(), await mk()];
		await link(a, { type: 'evidence', to: b, note: 'keep me' });

		await link(a, { type: 'evidence', to: b });
		await link(b, { type: 'evidence', from: a });

		expect(await readLinks(db, a)).toMatchObject([{ note: 'keep me' }]);
	});

	it('sets setBy and setAt when a Link is added', async () => {
		const [a, b] = [await mk(), await mk()];

		await link(a, { type: 'evidence', to: b }, day(4), other);

		expect((await readLinks(db, a))[0]).toMatchObject({
			setBy: other.id,
			via: null,
			setAt: day(4)
		});
	});

	it('sets setBy and setAt again when a Link is re-noted', async () => {
		const [a, b] = [await mk(), await mk()];
		await link(a, { type: 'evidence', to: b, note: 'first' }, day(2), actor);

		await link(a, { type: 'evidence', to: b, note: 'second' }, day(5), other);

		expect(await readLinks(db, a)).toEqual([
			{
				type: 'evidence',
				from: a,
				to: b,
				note: 'second',
				setBy: other.id,
				via: null,
				setAt: day(5)
			}
		]);
	});

	it('takes the last note when one item adds the same Link twice', async () => {
		const [a, b] = [await mk(), await mk()];

		await appraise(
			db,
			actor,
			[
				{
					labourId: a,
					links: [
						{ type: 'evidence', to: b, note: 'one' },
						{ type: 'evidence', to: b, note: 'two' }
					]
				}
			],
			day(2)
		);

		expect(await readLinks(db, a)).toMatchObject([{ note: 'two' }]);
	});
});

describe('removing Links', () => {
	it('deletes an existing Link', async () => {
		const [a, b] = [await mk(), await mk()];
		await link(a, { type: 'evidence', to: b });

		await link(a, { type: 'evidence', to: b, remove: true });

		expect(await readLinks(db, a)).toEqual([]);
		expect(await readLinks(db, b)).toEqual([]);
	});

	it('deletes a Link named from the other end', async () => {
		const [a, b] = [await mk(), await mk()];
		await link(a, { type: 'blocks', to: b });

		await link(b, { type: 'blocks', from: a, remove: true });

		expect(await readLinks(db, a)).toEqual([]);
	});

	it('does nothing, and raises nothing, when the Link is absent', async () => {
		const [a, b, c] = [await mk(), await mk(), await mk()];
		await link(a, { type: 'evidence', to: c });
		const before = await readLinks(db, a);

		const [result] = await link(a, { type: 'evidence', to: b, remove: true });

		expect(result.labourId).toBe(a);
		expect(await readLinks(db, a)).toEqual(before);
	});

	it('removes only the named type', async () => {
		const [a, b] = [await mk(), await mk()];
		await link(a, { type: 'evidence', to: b });
		await link(a, { type: 'blocks', to: b });

		await link(a, { type: 'evidence', to: b, remove: true });

		expect(edges(await readLinks(db, a))).toEqual([['blocks', a, b]]);
	});

	it('removes only the named direction', async () => {
		const [a, b] = [await mk(), await mk()];
		await link(a, { type: 'evidence', to: b });
		await link(b, { type: 'evidence', to: a });

		await link(a, { type: 'evidence', to: b, remove: true });

		expect(edges(await readLinks(db, a))).toEqual([['evidence', b, a]]);
	});

	it('removes only the named other end', async () => {
		const [a, b, c] = [await mk(), await mk(), await mk()];
		await link(a, { type: 'evidence', to: b });
		await link(a, { type: 'evidence', to: c });

		await link(a, { type: 'evidence', to: b, remove: true });

		expect(edges(await readLinks(db, a))).toEqual([['evidence', a, c]]);
	});

	it('ignores a note given with remove', async () => {
		const [a, b] = [await mk(), await mk()];
		await link(a, { type: 'evidence', to: b, note: 'keep' });

		await link(a, { type: 'evidence', to: b, note: 'ignored', remove: true });

		expect(await readLinks(db, a)).toEqual([]);
	});

	it('lets a Link be added anew after removal, with a fresh empty note', async () => {
		const [a, b] = [await mk(), await mk()];
		await link(a, { type: 'evidence', to: b, note: 'old' });
		await link(a, { type: 'evidence', to: b, remove: true });

		await link(a, { type: 'evidence', to: b });

		expect(await readLinks(db, a)).toMatchObject([{ note: '' }]);
	});

	it('removes a Link added earlier in the same batch', async () => {
		const [a, b] = [await mk(), await mk()];

		await appraise(
			db,
			actor,
			[
				{ labourId: a, links: [{ type: 'evidence', to: b }] },
				{ labourId: b, links: [{ type: 'evidence', from: a, remove: true }] }
			],
			day(2)
		);

		expect(await readLinks(db, a)).toEqual([]);
	});
});

describe('Link entry validation', () => {
	it('refuses an entry naming both to and from as invalid', async () => {
		const [a, b] = [await mk(), await mk()];

		await expectDomainError(() => link(a, { type: 'evidence', to: b, from: b }), 'invalid');
	});

	it('refuses an entry naming neither to nor from as invalid', async () => {
		const a = await mk();

		await expectDomainError(() => link(a, { type: 'evidence' }), 'invalid');
	});

	it('refuses a removal naming neither end as invalid', async () => {
		const a = await mk();

		await expectDomainError(() => link(a, { type: 'evidence', remove: true }), 'invalid');
	});

	it('refuses a Link from a Labour to itself with to, as invalid', async () => {
		const a = await mk();

		await expectDomainError(() => link(a, { type: 'relates', to: a }), 'invalid');
	});

	it('refuses a Link from a Labour to itself with from, as invalid', async () => {
		const a = await mk();

		await expectDomainError(() => link(a, { type: 'blocks', from: a }), 'invalid');
		expect(await readLinks(db, a)).toEqual([]);
	});

	it('refuses a self-removal as invalid', async () => {
		const a = await mk();

		await expectDomainError(() => link(a, { type: 'evidence', to: a, remove: true }), 'invalid');
	});

	it('refuses an unknown other end named with to as not_found', async () => {
		const a = await mk();

		await expectDomainError(() => link(a, { type: 'evidence', to: 9999 }), 'not_found');
	});

	it('refuses an unknown other end named with from as not_found', async () => {
		const a = await mk();

		await expectDomainError(() => link(a, { type: 'duplicates', from: 9999 }), 'not_found');
	});

	it('refuses an unknown other end on a removal as not_found', async () => {
		const a = await mk();

		await expectDomainError(
			() => link(a, { type: 'evidence', to: 9999, remove: true }),
			'not_found'
		);
	});
});

describe('blocks cycles', () => {
	it('refuses a Link back to a Labour that it blocks, naming both by key', async () => {
		const [a, b] = [await mk(), await mk()];
		await link(a, { type: 'blocks', to: b });

		const error = await expectDomainError(() => link(b, { type: 'blocks', to: a }), 'conflict');

		expect(error.message).toContain('AM-1');
		expect(error.message).toContain('AM-2');
		expect(edges(await readLinks(db, a))).toEqual([['blocks', a, b]]);
	});

	it('refuses the same cycle when the new Link is named from the other end', async () => {
		const [a, b] = [await mk(), await mk()];
		await link(a, { type: 'blocks', to: b });

		await expectDomainError(() => link(a, { type: 'blocks', from: b }), 'conflict');
	});

	it('refuses closing a longer chain, whichever end is appraised', async () => {
		const ids = await Promise.all(Array.from({ length: 5 }, () => mk()));
		for (let i = 0; i < 4; i++) await link(ids[i], { type: 'blocks', to: ids[i + 1] });

		await expectDomainError(() => link(ids[4], { type: 'blocks', to: ids[0] }), 'conflict');
		await expectDomainError(() => link(ids[0], { type: 'blocks', from: ids[4] }), 'conflict');
		expect(await readLinks(db, ids[0])).toHaveLength(1);
	});

	it('names the Labours by key', async () => {
		const [a, b, c] = [await mk(), await mk(), await mk()];
		await link(a, { type: 'blocks', to: b });
		await link(b, { type: 'blocks', to: c });

		const error = await expectDomainError(() => link(c, { type: 'blocks', to: a }), 'conflict');

		expect(error.message).toContain('AM-3');
		expect(error.message).toContain('AM-1');
	});

	it('refuses a cycle across Realms, naming the Labours by key', async () => {
		const a = await mk(am);
		const b = await mk(bl);
		const c = await mk(am);
		await link(a, { type: 'blocks', to: b });
		await link(b, { type: 'blocks', to: c });

		const error = await expectDomainError(() => link(c, { type: 'blocks', to: a }), 'conflict');

		expect(error.message).toContain('AM-1');
		expect(error.message).toContain('AM-2');
	});

	it('allows a diamond, which has two paths but no cycle', async () => {
		const [a, b, c, d] = [await mk(), await mk(), await mk(), await mk()];

		await link(a, { type: 'blocks', to: b });
		await link(a, { type: 'blocks', to: c });
		await link(b, { type: 'blocks', to: d });
		await link(c, { type: 'blocks', to: d });

		expect(await readLinks(db, d)).toHaveLength(2);
	});

	it('allows adding a blocks Link that already exists', async () => {
		const [a, b, c] = [await mk(), await mk(), await mk()];
		await link(a, { type: 'blocks', to: b });
		await link(b, { type: 'blocks', to: c });

		await link(a, { type: 'blocks', to: b, note: 're-noted' });

		expect((await readLinks(db, a))[0]).toMatchObject({ type: 'blocks', note: 're-noted' });
	});

	it('does not count evidence, relates or duplicates Links as part of a cycle', async () => {
		const [a, b, c] = [await mk(), await mk(), await mk()];
		await link(a, { type: 'blocks', to: b });
		await link(b, { type: 'evidence', to: a });
		await link(b, { type: 'relates', to: a });
		await link(b, { type: 'duplicates', to: a });

		await link(b, { type: 'blocks', to: c });
		await link(c, { type: 'evidence', to: a });
		await link(c, { type: 'duplicates', to: b });

		expect((await readLinks(db, c)).map((l) => l.type)).toEqual([
			'evidence',
			'blocks',
			'duplicates'
		]);
	});

	it('does not treat cycles in other Link types as conflicts', async () => {
		const [a, b] = [await mk(), await mk()];

		await link(a, { type: 'evidence', to: b });
		await link(b, { type: 'evidence', to: a });
		await link(a, { type: 'duplicates', to: b });
		await link(b, { type: 'duplicates', to: a });

		expect(await readLinks(db, a)).toHaveLength(4);
	});

	it('refuses a cycle closed across two items of one batch, writing neither', async () => {
		const [a, b] = [await mk(), await mk()];

		await expectDomainError(
			() =>
				appraise(
					db,
					actor,
					[
						{ labourId: a, links: [{ type: 'blocks', to: b }] },
						{ labourId: b, links: [{ type: 'blocks', to: a }] }
					],
					day(2)
				),
			'conflict'
		);

		expect(await readLinks(db, a)).toEqual([]);
	});

	it('refuses a cycle closed across three items of one batch', async () => {
		const [a, b, c] = [await mk(), await mk(), await mk()];

		const error = await expectDomainError(
			() =>
				appraise(
					db,
					actor,
					[
						{ labourId: a, links: [{ type: 'blocks', to: b }] },
						{ labourId: b, links: [{ type: 'blocks', to: c }] },
						{ labourId: c, links: [{ type: 'blocks', to: a }] }
					],
					day(2)
				),
			'conflict'
		);

		expect(error.message).toContain('AM-3');
		expect(error.message).toContain('AM-1');
		for (const id of [a, b, c]) expect(await readLinks(db, id)).toEqual([]);
	});

	it('refuses a cycle closed by two entries of one item', async () => {
		const [a, b] = [await mk(), await mk()];

		await expectDomainError(
			() =>
				appraise(
					db,
					actor,
					[
						{
							labourId: a,
							links: [
								{ type: 'blocks', to: b },
								{ type: 'blocks', from: b }
							]
						}
					],
					day(2)
				),
			'conflict'
		);

		expect(await readLinks(db, a)).toEqual([]);
	});

	it('refuses a cycle against a stored Link and rolls back the rest of the batch', async () => {
		const [a, b, c] = [await mk(), await mk(), await mk()];
		await link(a, { type: 'blocks', to: b });

		await expectDomainError(
			() =>
				appraise(
					db,
					actor,
					[
						{ labourId: c, brief: 'would be written', links: [{ type: 'evidence', to: a }] },
						{ labourId: b, links: [{ type: 'blocks', to: a }] }
					],
					day(2)
				),
			'conflict'
		);

		expect(edges(await readLinks(db, a))).toEqual([['blocks', a, b]]);
		expect(await readAppraisal(db, c)).toMatchObject({ brief: '', links: [] });
	});

	it('allows the reverse Link in a batch that first removes the Link in the way', async () => {
		const [a, b] = [await mk(), await mk()];
		await link(a, { type: 'blocks', to: b });

		await appraise(
			db,
			actor,
			[
				{ labourId: a, links: [{ type: 'blocks', to: b, remove: true }] },
				{ labourId: b, links: [{ type: 'blocks', to: a }] }
			],
			day(3)
		);

		expect(edges(await readLinks(db, a))).toEqual([['blocks', b, a]]);
	});
});

describe('Links across Realms', () => {
	it('connects Labours of different Realms, readable from both ends', async () => {
		const a = await mk(am);
		const b = await mk(bl);

		await link(a, { type: 'evidence', to: b, note: 'cross' });

		expect(edges(await readLinks(db, a))).toEqual([['evidence', a, b]]);
		expect(await readLinks(db, b)).toEqual(await readLinks(db, a));
	});

	it('survives a move of either Labour to another Realm', async () => {
		const a = await mk(am);
		const b = await mk(bl);
		await link(a, { type: 'blocks', to: b });

		await moveLabour(db, actor, a, { realmId: bl.id });

		expect(edges(await readLinks(db, a))).toEqual([['blocks', a, b]]);
	});
});

describe('Link cascades', () => {
	it('deletes a Link when its from Labour is deleted', async () => {
		const [a, b] = [await mk(), await mk()];
		await link(a, { type: 'evidence', to: b });

		await deleteLabour(db, actor, a);

		expect(await readLinks(db, b)).toEqual([]);
	});

	it('deletes a Link when its to Labour is deleted', async () => {
		const [a, b] = [await mk(), await mk()];
		await link(a, { type: 'evidence', to: b });

		await deleteLabour(db, actor, b);

		expect(await readLinks(db, a)).toEqual([]);
	});

	it('deletes a relates Link when either Labour is deleted', async () => {
		const [a, b, c] = [await mk(), await mk(), await mk()];
		await link(a, { type: 'relates', to: b });
		await link(b, { type: 'relates', to: c });

		await deleteLabour(db, actor, b);

		expect(await readLinks(db, a)).toEqual([]);
		expect(await readLinks(db, c)).toEqual([]);
	});

	it('leaves the other Links of the survivors in place', async () => {
		const [a, b, c] = [await mk(), await mk(), await mk()];
		await link(a, { type: 'evidence', to: b });
		await link(a, { type: 'blocks', to: c });

		await deleteLabour(db, actor, b);

		expect(edges(await readLinks(db, a))).toEqual([['blocks', a, c]]);
	});

	it('deletes Links to Labours in other Realms when a Realm is deleted', async () => {
		const inAm = await mk(am);
		const inBl = await mk(bl);
		const survivor = await mk(bl);
		await link(inAm, { type: 'evidence', to: inBl });
		await link(inAm, { type: 'relates', to: survivor });
		await link(inBl, { type: 'blocks', to: survivor });

		await deleteRealm(db, actor, am.id);

		expect(edges(await readLinks(db, inBl))).toEqual([['blocks', inBl, survivor]]);
		expect(edges(await readLinks(db, survivor))).toEqual([['blocks', inBl, survivor]]);
	});

	it('refuses a Link to a deleted Labour as not_found', async () => {
		const [a, b] = [await mk(), await mk()];
		await link(a, { type: 'evidence', to: b });
		await deleteLabour(db, actor, b);

		await expectDomainError(() => link(a, { type: 'evidence', to: b }), 'not_found');
	});
});
