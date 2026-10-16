import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
	other = { id: seedUser(db, 'other') };
	am = seedRealm(db, 'AM');
	bl = seedRealm(db, 'BL');
});

afterEach(() => {
	db.$client.close();
});

const day = (n: number) => new Date(Date.UTC(2030, 0, n));

function expectDomainError(action: () => unknown, code: DomainError['code']): DomainError {
	let thrown: unknown;
	try {
		action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(DomainError);
	expect((thrown as DomainError).code).toBe(code);
	return thrown as DomainError;
}

const mk = (realm: { id: number } = am) => seedLabour(db, { realmId: realm.id }).id;

type Entry = NonNullable<AppraiseItem['links']>[number];

const link = (labourId: number, entry: Entry, now = day(2), by = actor) =>
	appraise(db, by, [{ labourId, links: [entry] }], now);

const edges = (links: LinkView[]) => links.map((l) => [l.type, l.from, l.to]);

describe('Link direction', () => {
	it.each<LinkType>(['evidence', 'blocks', 'duplicates'])(
		'makes the appraised Labour the from end of a %s Link named with to',
		(type) => {
			const [a, b] = [mk(), mk()];

			link(a, { type, to: b });

			expect(edges(readLinks(db, a))).toEqual([[type, a, b]]);
		}
	);

	it.each<LinkType>(['evidence', 'blocks', 'duplicates'])(
		'makes the appraised Labour the to end of a %s Link named with from',
		(type) => {
			const [a, b] = [mk(), mk()];

			link(a, { type, from: b });

			expect(edges(readLinks(db, a))).toEqual([[type, b, a]]);
		}
	);

	it('stores the same Link whichever Labour names the other', () => {
		const [a, b] = [mk(), mk()];

		link(a, { type: 'evidence', to: b });
		link(b, { type: 'evidence', from: a });

		expect(readLinks(db, a)).toHaveLength(1);
	});

	it('keeps evidence in opposite directions as two Links', () => {
		const [a, b] = [mk(), mk()];

		link(a, { type: 'evidence', to: b });
		link(b, { type: 'evidence', to: a });

		expect(edges(readLinks(db, a))).toEqual([
			['evidence', a, b],
			['evidence', b, a]
		]);
	});

	it('keeps duplicates in opposite directions as two Links', () => {
		const [a, b] = [mk(), mk()];

		link(a, { type: 'duplicates', to: b });
		link(b, { type: 'duplicates', to: a });

		expect(readLinks(db, a)).toHaveLength(2);
	});

	it('keeps Links of different types between the same pair', () => {
		const [a, b] = [mk(), mk()];

		link(a, { type: 'evidence', to: b });
		link(a, { type: 'blocks', to: b });
		link(a, { type: 'relates', to: b });
		link(a, { type: 'duplicates', to: b });

		expect(readLinks(db, a).map((l) => l.type)).toEqual([
			'evidence',
			'blocks',
			'relates',
			'duplicates'
		]);
	});

	it('adds one Link for the same (from, to, type) however often it is added', () => {
		const [a, b] = [mk(), mk()];

		link(a, { type: 'blocks', to: b });
		link(a, { type: 'blocks', to: b });
		link(b, { type: 'blocks', from: a });

		expect(readLinks(db, a)).toHaveLength(1);
	});
});

describe('relates', () => {
	it('is stored with the lower id as from when the higher id names the lower with to', () => {
		const [low, high] = [mk(), mk()];

		link(high, { type: 'relates', to: low });

		expect(edges(readLinks(db, low))).toEqual([['relates', low, high]]);
	});

	it('is stored with the lower id as from when the higher id names the lower with from', () => {
		const [low, high] = [mk(), mk()];

		link(high, { type: 'relates', from: low });

		expect(edges(readLinks(db, low))).toEqual([['relates', low, high]]);
	});

	it('is stored with the lower id as from when the lower id names the higher', () => {
		const [low, high] = [mk(), mk()];

		link(low, { type: 'relates', to: high });
		expect(edges(readLinks(db, high))).toEqual([['relates', low, high]]);
		link(low, { type: 'relates', from: high });
		expect(edges(readLinks(db, high))).toEqual([['relates', low, high]]);
	});

	it('is one Link however the two Labours name each other', () => {
		const [low, high] = [mk(), mk()];

		link(low, { type: 'relates', to: high });
		link(high, { type: 'relates', to: low });
		link(low, { type: 'relates', from: high });
		link(high, { type: 'relates', from: low });

		expect(readLinks(db, low)).toHaveLength(1);
	});

	it('is re-noted from the other end', () => {
		const [low, high] = [mk(), mk()];
		link(low, { type: 'relates', to: high, note: 'first' });

		link(high, { type: 'relates', to: low, note: 'second' });

		expect(readLinks(db, low)).toMatchObject([{ note: 'second' }]);
	});

	it('is removed from either end', () => {
		const [low, high] = [mk(), mk()];

		link(low, { type: 'relates', to: high });
		link(high, { type: 'relates', to: low, remove: true });
		expect(readLinks(db, low)).toEqual([]);

		link(low, { type: 'relates', to: high });
		link(low, { type: 'relates', from: high, remove: true });
		expect(readLinks(db, low)).toEqual([]);
	});

	it('does not stop a pair relating while a directed Link of another type stands', () => {
		const [a, b] = [mk(), mk()];
		link(a, { type: 'blocks', to: b });

		link(b, { type: 'relates', to: a });

		expect(readLinks(db, a).map((l) => l.type)).toEqual(['blocks', 'relates']);
	});
});

describe('readLinks', () => {
	it('is empty for a Labour with no Links', () => {
		expect(readLinks(db, mk())).toEqual([]);
	});

	it('returns each Link in full', () => {
		const [a, b] = [mk(), mk()];

		link(a, { type: 'evidence', to: b, note: 'logs show it' }, day(3), other);

		expect(readLinks(db, a)).toEqual([
			{ type: 'evidence', from: a, to: b, note: 'logs show it', setBy: other.id, setAt: day(3) }
		]);
	});

	it('returns a Link from both its ends', () => {
		const [a, b] = [mk(), mk()];
		link(a, { type: 'duplicates', to: b });

		expect(readLinks(db, b)).toEqual(readLinks(db, a));
		expect(readLinks(db, b)).toHaveLength(1);
	});

	it('orders by type, then from, then to', () => {
		const [a, b, c, d] = [mk(), mk(), mk(), mk()];
		link(b, { type: 'duplicates', to: d });
		link(c, { type: 'evidence', to: b });
		link(b, { type: 'relates', to: c });
		link(a, { type: 'blocks', to: b });
		link(b, { type: 'evidence', to: c });
		link(b, { type: 'blocks', to: d });
		link(a, { type: 'relates', to: b });
		link(a, { type: 'evidence', to: b });

		expect(edges(readLinks(db, b))).toEqual([
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

	it('does not include Links between other Labours', () => {
		const [a, b, c] = [mk(), mk(), mk()];
		link(b, { type: 'evidence', to: c });

		expect(readLinks(db, a)).toEqual([]);
	});
});

describe('Link notes', () => {
	it('is empty when a new Link is added without one', () => {
		const [a, b] = [mk(), mk()];

		link(a, { type: 'evidence', to: b });

		expect(readLinks(db, a)[0].note).toBe('');
	});

	it('is stored trimmed', () => {
		const [a, b] = [mk(), mk()];

		link(a, { type: 'evidence', to: b, note: '  spaced out \n' });

		expect(readLinks(db, a)[0].note).toBe('spaced out');
	});

	it('accepts 500 characters and refuses 501 as invalid', () => {
		const [a, b] = [mk(), mk()];

		link(a, { type: 'evidence', to: b, note: 'n'.repeat(500) });
		expect(readLinks(db, a)[0].note).toHaveLength(500);

		expectDomainError(() => link(a, { type: 'evidence', to: b, note: 'n'.repeat(501) }), 'invalid');
		expect(readLinks(db, a)[0].note).toHaveLength(500);
	});

	it('refuses an over-long note on a new Link without adding it', () => {
		const [a, b] = [mk(), mk()];

		expectDomainError(() => link(a, { type: 'blocks', to: b, note: 'n'.repeat(501) }), 'invalid');

		expect(readLinks(db, a)).toEqual([]);
	});

	it('replaces the note of an existing Link when a note is given', () => {
		const [a, b] = [mk(), mk()];
		link(a, { type: 'evidence', to: b, note: 'old' });

		link(a, { type: 'evidence', to: b, note: 'new' });

		expect(readLinks(db, a)).toMatchObject([{ note: 'new' }]);
	});

	it('clears the note of an existing Link when an empty note is given', () => {
		const [a, b] = [mk(), mk()];
		link(a, { type: 'evidence', to: b, note: 'old' });

		link(a, { type: 'evidence', to: b, note: '' });

		expect(readLinks(db, a)[0].note).toBe('');
	});

	it('keeps the note of an existing Link when none is given', () => {
		const [a, b] = [mk(), mk()];
		link(a, { type: 'evidence', to: b, note: 'keep me' });

		link(a, { type: 'evidence', to: b });
		link(b, { type: 'evidence', from: a });

		expect(readLinks(db, a)).toMatchObject([{ note: 'keep me' }]);
	});

	it('sets setBy and setAt when a Link is added', () => {
		const [a, b] = [mk(), mk()];

		link(a, { type: 'evidence', to: b }, day(4), other);

		expect(readLinks(db, a)[0]).toMatchObject({ setBy: other.id, setAt: day(4) });
	});

	it('sets setBy and setAt again when a Link is re-noted', () => {
		const [a, b] = [mk(), mk()];
		link(a, { type: 'evidence', to: b, note: 'first' }, day(2), actor);

		link(a, { type: 'evidence', to: b, note: 'second' }, day(5), other);

		expect(readLinks(db, a)).toEqual([
			{ type: 'evidence', from: a, to: b, note: 'second', setBy: other.id, setAt: day(5) }
		]);
	});

	it('takes the last note when one item adds the same Link twice', () => {
		const [a, b] = [mk(), mk()];

		appraise(
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

		expect(readLinks(db, a)).toMatchObject([{ note: 'two' }]);
	});
});

describe('removing Links', () => {
	it('deletes an existing Link', () => {
		const [a, b] = [mk(), mk()];
		link(a, { type: 'evidence', to: b });

		link(a, { type: 'evidence', to: b, remove: true });

		expect(readLinks(db, a)).toEqual([]);
		expect(readLinks(db, b)).toEqual([]);
	});

	it('deletes a Link named from the other end', () => {
		const [a, b] = [mk(), mk()];
		link(a, { type: 'blocks', to: b });

		link(b, { type: 'blocks', from: a, remove: true });

		expect(readLinks(db, a)).toEqual([]);
	});

	it('does nothing, and raises nothing, when the Link is absent', () => {
		const [a, b, c] = [mk(), mk(), mk()];
		link(a, { type: 'evidence', to: c });
		const before = readLinks(db, a);

		const [result] = link(a, { type: 'evidence', to: b, remove: true });

		expect(result.labourId).toBe(a);
		expect(readLinks(db, a)).toEqual(before);
	});

	it('removes only the named type', () => {
		const [a, b] = [mk(), mk()];
		link(a, { type: 'evidence', to: b });
		link(a, { type: 'blocks', to: b });

		link(a, { type: 'evidence', to: b, remove: true });

		expect(edges(readLinks(db, a))).toEqual([['blocks', a, b]]);
	});

	it('removes only the named direction', () => {
		const [a, b] = [mk(), mk()];
		link(a, { type: 'evidence', to: b });
		link(b, { type: 'evidence', to: a });

		link(a, { type: 'evidence', to: b, remove: true });

		expect(edges(readLinks(db, a))).toEqual([['evidence', b, a]]);
	});

	it('removes only the named other end', () => {
		const [a, b, c] = [mk(), mk(), mk()];
		link(a, { type: 'evidence', to: b });
		link(a, { type: 'evidence', to: c });

		link(a, { type: 'evidence', to: b, remove: true });

		expect(edges(readLinks(db, a))).toEqual([['evidence', a, c]]);
	});

	it('ignores a note given with remove', () => {
		const [a, b] = [mk(), mk()];
		link(a, { type: 'evidence', to: b, note: 'keep' });

		link(a, { type: 'evidence', to: b, note: 'ignored', remove: true });

		expect(readLinks(db, a)).toEqual([]);
	});

	it('lets a Link be added anew after removal, with a fresh empty note', () => {
		const [a, b] = [mk(), mk()];
		link(a, { type: 'evidence', to: b, note: 'old' });
		link(a, { type: 'evidence', to: b, remove: true });

		link(a, { type: 'evidence', to: b });

		expect(readLinks(db, a)).toMatchObject([{ note: '' }]);
	});

	it('removes a Link added earlier in the same batch', () => {
		const [a, b] = [mk(), mk()];

		appraise(
			db,
			actor,
			[
				{ labourId: a, links: [{ type: 'evidence', to: b }] },
				{ labourId: b, links: [{ type: 'evidence', from: a, remove: true }] }
			],
			day(2)
		);

		expect(readLinks(db, a)).toEqual([]);
	});
});

describe('Link entry validation', () => {
	it('refuses an entry naming both to and from as invalid', () => {
		const [a, b] = [mk(), mk()];

		expectDomainError(() => link(a, { type: 'evidence', to: b, from: b }), 'invalid');
	});

	it('refuses an entry naming neither to nor from as invalid', () => {
		const a = mk();

		expectDomainError(() => link(a, { type: 'evidence' }), 'invalid');
	});

	it('refuses a removal naming neither end as invalid', () => {
		const a = mk();

		expectDomainError(() => link(a, { type: 'evidence', remove: true }), 'invalid');
	});

	it('refuses a Link from a Labour to itself with to, as invalid', () => {
		const a = mk();

		expectDomainError(() => link(a, { type: 'relates', to: a }), 'invalid');
	});

	it('refuses a Link from a Labour to itself with from, as invalid', () => {
		const a = mk();

		expectDomainError(() => link(a, { type: 'blocks', from: a }), 'invalid');
		expect(readLinks(db, a)).toEqual([]);
	});

	it('refuses a self-removal as invalid', () => {
		const a = mk();

		expectDomainError(() => link(a, { type: 'evidence', to: a, remove: true }), 'invalid');
	});

	it('refuses an unknown other end named with to as not_found', () => {
		const a = mk();

		expectDomainError(() => link(a, { type: 'evidence', to: 9999 }), 'not_found');
	});

	it('refuses an unknown other end named with from as not_found', () => {
		const a = mk();

		expectDomainError(() => link(a, { type: 'duplicates', from: 9999 }), 'not_found');
	});

	it('refuses an unknown other end on a removal as not_found', () => {
		const a = mk();

		expectDomainError(() => link(a, { type: 'evidence', to: 9999, remove: true }), 'not_found');
	});
});

describe('blocks cycles', () => {
	it('refuses a Link back to a Labour that it blocks, naming both by key', () => {
		const [a, b] = [mk(), mk()];
		link(a, { type: 'blocks', to: b });

		const error = expectDomainError(() => link(b, { type: 'blocks', to: a }), 'conflict');

		expect(error.message).toContain('AM-1');
		expect(error.message).toContain('AM-2');
		expect(edges(readLinks(db, a))).toEqual([['blocks', a, b]]);
	});

	it('refuses the same cycle when the new Link is named from the other end', () => {
		const [a, b] = [mk(), mk()];
		link(a, { type: 'blocks', to: b });

		expectDomainError(() => link(a, { type: 'blocks', from: b }), 'conflict');
	});

	it('refuses closing a longer chain, whichever end is appraised', () => {
		const ids = Array.from({ length: 5 }, () => mk());
		for (let i = 0; i < 4; i++) link(ids[i], { type: 'blocks', to: ids[i + 1] });

		expectDomainError(() => link(ids[4], { type: 'blocks', to: ids[0] }), 'conflict');
		expectDomainError(() => link(ids[0], { type: 'blocks', from: ids[4] }), 'conflict');
		expect(readLinks(db, ids[0])).toHaveLength(1);
	});

	it('names the Labours by key', () => {
		const [a, b, c] = [mk(), mk(), mk()];
		link(a, { type: 'blocks', to: b });
		link(b, { type: 'blocks', to: c });

		const error = expectDomainError(() => link(c, { type: 'blocks', to: a }), 'conflict');

		expect(error.message).toContain('AM-3');
		expect(error.message).toContain('AM-1');
	});

	it('refuses a cycle across Realms, naming the Labours by key', () => {
		const a = mk(am);
		const b = mk(bl);
		const c = mk(am);
		link(a, { type: 'blocks', to: b });
		link(b, { type: 'blocks', to: c });

		const error = expectDomainError(() => link(c, { type: 'blocks', to: a }), 'conflict');

		expect(error.message).toContain('AM-1');
		expect(error.message).toContain('AM-2');
	});

	it('allows a diamond, which has two paths but no cycle', () => {
		const [a, b, c, d] = [mk(), mk(), mk(), mk()];

		link(a, { type: 'blocks', to: b });
		link(a, { type: 'blocks', to: c });
		link(b, { type: 'blocks', to: d });
		link(c, { type: 'blocks', to: d });

		expect(readLinks(db, d)).toHaveLength(2);
	});

	it('allows adding a blocks Link that already exists', () => {
		const [a, b, c] = [mk(), mk(), mk()];
		link(a, { type: 'blocks', to: b });
		link(b, { type: 'blocks', to: c });

		link(a, { type: 'blocks', to: b, note: 're-noted' });

		expect(readLinks(db, a)[0]).toMatchObject({ type: 'blocks', note: 're-noted' });
	});

	it('does not count evidence, relates or duplicates Links as part of a cycle', () => {
		const [a, b, c] = [mk(), mk(), mk()];
		link(a, { type: 'blocks', to: b });
		link(b, { type: 'evidence', to: a });
		link(b, { type: 'relates', to: a });
		link(b, { type: 'duplicates', to: a });

		link(b, { type: 'blocks', to: c });
		link(c, { type: 'evidence', to: a });
		link(c, { type: 'duplicates', to: b });

		expect(readLinks(db, c).map((l) => l.type)).toEqual(['evidence', 'blocks', 'duplicates']);
	});

	it('does not treat cycles in other Link types as conflicts', () => {
		const [a, b] = [mk(), mk()];

		link(a, { type: 'evidence', to: b });
		link(b, { type: 'evidence', to: a });
		link(a, { type: 'duplicates', to: b });
		link(b, { type: 'duplicates', to: a });

		expect(readLinks(db, a)).toHaveLength(4);
	});

	it('refuses a cycle closed across two items of one batch, writing neither', () => {
		const [a, b] = [mk(), mk()];

		expectDomainError(
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

		expect(readLinks(db, a)).toEqual([]);
	});

	it('refuses a cycle closed across three items of one batch', () => {
		const [a, b, c] = [mk(), mk(), mk()];

		const error = expectDomainError(
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
		for (const id of [a, b, c]) expect(readLinks(db, id)).toEqual([]);
	});

	it('refuses a cycle closed by two entries of one item', () => {
		const [a, b] = [mk(), mk()];

		expectDomainError(
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

		expect(readLinks(db, a)).toEqual([]);
	});

	it('refuses a cycle against a stored Link and rolls back the rest of the batch', () => {
		const [a, b, c] = [mk(), mk(), mk()];
		link(a, { type: 'blocks', to: b });

		expectDomainError(
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

		expect(edges(readLinks(db, a))).toEqual([['blocks', a, b]]);
		expect(readAppraisal(db, c)).toMatchObject({ brief: '', links: [] });
	});

	it('allows the reverse Link in a batch that first removes the Link in the way', () => {
		const [a, b] = [mk(), mk()];
		link(a, { type: 'blocks', to: b });

		appraise(
			db,
			actor,
			[
				{ labourId: a, links: [{ type: 'blocks', to: b, remove: true }] },
				{ labourId: b, links: [{ type: 'blocks', to: a }] }
			],
			day(3)
		);

		expect(edges(readLinks(db, a))).toEqual([['blocks', b, a]]);
	});
});

describe('Links across Realms', () => {
	it('connects Labours of different Realms, readable from both ends', () => {
		const a = mk(am);
		const b = mk(bl);

		link(a, { type: 'evidence', to: b, note: 'cross' });

		expect(edges(readLinks(db, a))).toEqual([['evidence', a, b]]);
		expect(readLinks(db, b)).toEqual(readLinks(db, a));
	});

	it('survives a move of either Labour to another Realm', () => {
		const a = mk(am);
		const b = mk(bl);
		link(a, { type: 'blocks', to: b });

		moveLabour(db, actor, a, { realmId: bl.id });

		expect(edges(readLinks(db, a))).toEqual([['blocks', a, b]]);
	});
});

describe('Link cascades', () => {
	it('deletes a Link when its from Labour is deleted', () => {
		const [a, b] = [mk(), mk()];
		link(a, { type: 'evidence', to: b });

		deleteLabour(db, actor, a);

		expect(readLinks(db, b)).toEqual([]);
	});

	it('deletes a Link when its to Labour is deleted', () => {
		const [a, b] = [mk(), mk()];
		link(a, { type: 'evidence', to: b });

		deleteLabour(db, actor, b);

		expect(readLinks(db, a)).toEqual([]);
	});

	it('deletes a relates Link when either Labour is deleted', () => {
		const [a, b, c] = [mk(), mk(), mk()];
		link(a, { type: 'relates', to: b });
		link(b, { type: 'relates', to: c });

		deleteLabour(db, actor, b);

		expect(readLinks(db, a)).toEqual([]);
		expect(readLinks(db, c)).toEqual([]);
	});

	it('leaves the other Links of the survivors in place', () => {
		const [a, b, c] = [mk(), mk(), mk()];
		link(a, { type: 'evidence', to: b });
		link(a, { type: 'blocks', to: c });

		deleteLabour(db, actor, b);

		expect(edges(readLinks(db, a))).toEqual([['blocks', a, c]]);
	});

	it('deletes Links to Labours in other Realms when a Realm is deleted', () => {
		const inAm = mk(am);
		const inBl = mk(bl);
		const survivor = mk(bl);
		link(inAm, { type: 'evidence', to: inBl });
		link(inAm, { type: 'relates', to: survivor });
		link(inBl, { type: 'blocks', to: survivor });

		deleteRealm(db, actor, am.id);

		expect(edges(readLinks(db, inBl))).toEqual([['blocks', inBl, survivor]]);
		expect(edges(readLinks(db, survivor))).toEqual([['blocks', inBl, survivor]]);
	});

	it('refuses a Link to a deleted Labour as not_found', () => {
		const [a, b] = [mk(), mk()];
		link(a, { type: 'evidence', to: b });
		deleteLabour(db, actor, b);

		expectDomainError(() => link(a, { type: 'evidence', to: b }), 'not_found');
	});
});
