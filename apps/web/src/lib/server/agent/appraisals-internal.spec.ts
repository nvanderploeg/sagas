import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { appraisals, events, labours, links } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { deleteLabour } from '#lib/server/domain/labours.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb, expectFailure } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm } from '#lib/server/test/fixtures.ts';
import { appraise, readAppraisal } from './appraisals.ts';
import { defineAttribute, readRealmAgent, readValues } from './attributes.ts';
import { contentHash } from './content.ts';
import { readLinks } from './links.ts';

let db: Db;
let actor: Actor;
let realmId: number;

const NOW = new Date('2026-03-01T00:00:00Z');

beforeEach(async () => {
	db = await testDb();
	actor = await seedActor(db);
	realmId = (await seedRealm(db, 'AM')).id;
});

async function failure(action: () => unknown): Promise<DomainError> {
	try {
		await action();
	} catch (error) {
		if (error instanceof DomainError) return error;
		throw error;
	}
	throw new Error('expected a DomainError');
}

const labour = (over: Parameters<typeof seedLabour>[1] = { realmId }) => seedLabour(db, over);
const linkRows = async () => await db.select().from(links);
const appraisalRows = async () => await db.select().from(appraisals);

describe('schema', () => {
	const stamp = (over: Record<string, unknown>) => {
		const row = {
			labour_id: 0,
			content_hash: null,
			appraised_by: null,
			appraised_at: null,
			...over
		};
		return db.$client.query(
			`INSERT INTO appraisals (labour_id, content_hash, appraised_by, appraised_at)
			 VALUES ($1, $2, $3, $4)`,
			[row.labour_id, row.content_hash, row.appraised_by, row.appraised_at]
		);
	};

	it('takes a stamp whole or not at all', async () => {
		const { id } = await labour();
		const by = actor.id;
		await expectFailure(stamp({ labour_id: id, content_hash: 'h' }), /violates check constraint/);
		await expectFailure(stamp({ labour_id: id, appraised_by: by }), /violates check constraint/);
		await expectFailure(stamp({ labour_id: id, appraised_at: 1 }), /violates check constraint/);
		await expectFailure(
			stamp({ labour_id: id, content_hash: 'h', appraised_by: by }),
			/violates check constraint/
		);
		await stamp({ labour_id: id, content_hash: 'h', appraised_by: by, appraised_at: 1 });
	});

	it('allows a row with no setBy, setAt or stamp', async () => {
		const { id } = await labour();
		await stamp({ labour_id: id });
		expect((await appraisalRows())[0]).toMatchObject({
			brief: '',
			refs: [],
			setBy: null,
			setAt: null
		});
	});

	it('refuses refs that are not JSON', async () => {
		const { id } = await labour();
		const put = (refs: string) =>
			db.$client.query('INSERT INTO appraisals (labour_id, refs) VALUES ($1, $2)', [id, refs]);
		await expectFailure(put('{nope'), /invalid input syntax for type json/);
		await expect(put('[]')).resolves.toBeDefined();
	});

	const put = (from: number, to: number, type = 'evidence') =>
		db.$client.query(
			'INSERT INTO links (from_id, to_id, type, set_by, set_at) VALUES ($1, $2, $3, $4, 0)',
			[from, to, type, actor.id]
		);

	it('refuses a Link to itself, an unknown type and an unordered relates', async () => {
		const a = (await labour()).id;
		const b = (await labour()).id;
		await expectFailure(put(a, a), /violates check constraint/);
		await expectFailure(put(a, b, 'mentions'), /violates check constraint/);
		await expectFailure(put(b, a, 'relates'), /violates check constraint/);
		await put(a, b, 'relates');
	});

	it('refuses a second Link of one type between two Labours and allows another type', async () => {
		const a = (await labour()).id;
		const b = (await labour()).id;
		await put(a, b, 'blocks');
		await expectFailure(put(a, b, 'blocks'), /duplicate key value/);
		await put(b, a, 'blocks');
		await put(a, b, 'evidence');
	});

	it('deletes an Appraisal with its Labour and a Link with either end', async () => {
		const a = (await labour()).id;
		const b = (await labour()).id;
		const c = (await labour()).id;
		await appraise(db, actor, [
			{
				labourId: a,
				brief: 'x',
				links: [
					{ type: 'evidence', to: b },
					{ type: 'blocks', from: c }
				]
			},
			{ labourId: b, brief: 'y' }
		]);
		expect(await appraisalRows()).toHaveLength(2);
		expect(await linkRows()).toHaveLength(2);

		await deleteLabour(db, actor, c);
		expect((await linkRows()).map((row) => row.type)).toEqual(['evidence']);
		await deleteLabour(db, actor, b);
		expect(await linkRows()).toHaveLength(0);
		expect((await appraisalRows()).map((row) => row.labourId)).toEqual([a]);
		await deleteLabour(db, actor, a);
		expect(await appraisalRows()).toHaveLength(0);
	});

	it('deletes Appraisals and Links with their Realm', async () => {
		const other = (await seedRealm(db, 'OT')).id;
		const a = (await labour({ realmId: other })).id;
		const b = (await labour()).id;
		await appraise(db, actor, [{ labourId: a, brief: 'x', links: [{ type: 'relates', to: b }] }]);
		await db.$client.query('DELETE FROM realms WHERE id = $1', [other]);
		expect(await appraisalRows()).toHaveLength(0);
		expect(await linkRows()).toHaveLength(0);
	});
});

describe('blocks cycles', () => {
	it('searches Links added earlier in the same batch', async () => {
		const [a, b, c] = [await labour(), await labour(), await labour()];
		const error = await failure(() =>
			appraise(db, actor, [
				{ labourId: a.id, links: [{ type: 'blocks', to: b.id }] },
				{ labourId: b.id, links: [{ type: 'blocks', to: c.id }] },
				{ labourId: c.id, links: [{ type: 'blocks', to: a.id }] }
			])
		);
		expect(error.code).toBe('conflict');
		expect(error.message).toContain(c.key);
		expect(error.message).toContain(a.key);
		expect(await linkRows()).toHaveLength(0);
	});

	it('finds a cycle named from the other end of the Link', async () => {
		const [a, b, c] = [await labour(), await labour(), await labour()];
		await appraise(db, actor, [
			{ labourId: b.id, links: [{ type: 'blocks', from: a.id }] },
			{ labourId: c.id, links: [{ type: 'blocks', from: b.id }] }
		]);
		const error = await failure(() =>
			appraise(db, actor, [{ labourId: a.id, links: [{ type: 'blocks', from: c.id }] }])
		);
		expect(error.code).toBe('conflict');
	});

	it('walks a long chain and a shortcut without looping', async () => {
		const ids = await Promise.all(Array.from({ length: 6 }, async () => (await labour()).id));
		await appraise(
			db,
			actor,
			ids.slice(0, -1).map((id, i) => ({
				labourId: id,
				links: [
					{ type: 'blocks' as const, to: ids[i + 1]! },
					...(i === 0 ? [{ type: 'blocks' as const, to: ids[3]! }] : [])
				]
			}))
		);
		expect(
			(
				await failure(() =>
					appraise(db, actor, [{ labourId: ids[5]!, links: [{ type: 'blocks', to: ids[0]! }] }])
				)
			).code
		).toBe('conflict');
		await appraise(db, actor, [{ labourId: ids[0]!, links: [{ type: 'blocks', to: ids[5]! }] }]);
	});

	it('lets other types close a loop and a removed Link reopen the way', async () => {
		const a = (await labour()).id;
		const b = (await labour()).id;
		await appraise(db, actor, [{ labourId: a, links: [{ type: 'blocks', to: b }] }]);
		await appraise(db, actor, [{ labourId: b, links: [{ type: 'evidence', to: a }] }]);
		expect(
			(
				await failure(() =>
					appraise(db, actor, [{ labourId: b, links: [{ type: 'blocks', to: a }] }])
				)
			).code
		).toBe('conflict');
		await appraise(db, actor, [{ labourId: a, links: [{ type: 'blocks', to: b, remove: true }] }]);
		await appraise(db, actor, [{ labourId: b, links: [{ type: 'blocks', to: a }] }]);
	});

	it('removes then re-adds in the opposite direction within one item', async () => {
		const a = (await labour()).id;
		const b = (await labour()).id;
		await appraise(db, actor, [{ labourId: a, links: [{ type: 'blocks', to: b }] }]);
		await appraise(db, actor, [
			{
				labourId: a,
				links: [
					{ type: 'blocks', to: b, remove: true },
					{ type: 'blocks', from: b }
				]
			}
		]);
		expect((await linkRows()).map((row) => [row.fromId, row.toId])).toEqual([[b, a]]);
	});
});

describe('a batch is all or nothing', () => {
	it('undoes earlier items when a later one fails', async () => {
		await defineAttribute(db, actor, realmId, {
			key: 'size',
			kind: 'scale',
			label: 'Size',
			rubric: 'r',
			spec: { min: 1, max: 5 }
		});
		const before = (await readRealmAgent(db, realmId)).version;
		const a = await labour();
		const b = await labour();
		const c = await labour();
		const hash = await contentHash(db, a.id);

		const run = (last: Parameters<typeof appraise>[2][number]) =>
			appraise(
				db,
				actor,
				[
					{
						labourId: a.id,
						brief: 'first',
						refs: [{ href: 'src/a.ts' }],
						values: { size: 3 },
						links: [{ type: 'relates', to: b.id, note: 'n' }],
						stamp: hash
					},
					{ labourId: b.id, values: { size: 4 }, links: [{ type: 'evidence', from: c.id }] },
					last
				],
				NOW
			);

		expect((await failure(() => run({ labourId: 999_999, brief: 'x' }))).code).toBe('not_found');
		expect((await failure(() => run({ labourId: c.id, brief: 'x'.repeat(401) }))).code).toBe(
			'invalid'
		);
		expect((await failure(() => run({ labourId: c.id, values: { size: 9 } }))).code).toBe(
			'invalid'
		);
		expect(
			(await failure(() => run({ labourId: c.id, links: [{ type: 'blocks', to: c.id }] }))).code
		).toBe('invalid');

		expect(await appraisalRows()).toHaveLength(0);
		expect(await linkRows()).toHaveLength(0);
		expect(await readValues(db, a.id)).toEqual([]);
		expect(await readValues(db, b.id)).toEqual([]);
		expect((await readRealmAgent(db, realmId)).version).toBe(before);

		await run({ labourId: c.id, brief: 'ok' });
		expect(await appraisalRows()).toHaveLength(2);
		expect((await readAppraisal(db, a.id)).stamp?.contentHash).toBe(hash);
		expect((await readRealmAgent(db, realmId)).version).toBe(before + 1);
	});

	it('refuses a repeated Labour and a batch size outside 1 to 50 before writing', async () => {
		const a = (await labour()).id;
		const b = (await labour()).id;
		expect(
			(
				await failure(() =>
					appraise(db, actor, [
						{ labourId: a, brief: 'x' },
						{ labourId: b, brief: 'y' },
						{ labourId: a, brief: 'z' }
					])
				)
			).code
		).toBe('invalid');
		expect((await failure(() => appraise(db, actor, []))).code).toBe('invalid');
		const many = await Promise.all(
			Array.from({ length: 51 }, async () => ({
				labourId: (await labour()).id,
				brief: 'x'
			}))
		);
		expect((await failure(() => appraise(db, actor, many))).code).toBe('invalid');
		expect(await appraisalRows()).toHaveLength(0);
		expect(await appraise(db, actor, many.slice(0, 50))).toHaveLength(50);
	});
});

describe('what appraise leaves alone', () => {
	it('records no Event and keeps updatedAt', async () => {
		const a = await labour();
		const b = await labour();
		const eventsBefore = (await db.select().from(events)).length;
		const updated = async (id: number) =>
			(
				await db.select({ at: labours.updatedAt }).from(labours).where(eq(labours.id, id)).limit(1)
			)[0]!.at;
		const stamps = [await updated(a.id), await updated(b.id)];

		await appraise(
			db,
			actor,
			[
				{
					labourId: a.id,
					brief: 'x',
					refs: [{ href: 'h' }],
					links: [{ type: 'duplicates', to: b.id }],
					stamp: await contentHash(db, a.id)
				}
			],
			new Date('2030-01-01T00:00:00Z')
		);

		expect(await db.select().from(events)).toHaveLength(eventsBefore);
		expect([await updated(a.id), await updated(b.id)]).toEqual(stamps);
	});

	it('keeps the Brief when only the stamp is written', async () => {
		const a = (await labour()).id;
		await appraise(
			db,
			actor,
			[{ labourId: a, brief: 'kept', refs: [{ href: 'h', label: 'L' }] }],
			NOW
		);
		await appraise(
			db,
			actor,
			[{ labourId: a, stamp: await contentHash(db, a) }],
			new Date(NOW.getTime() + 1)
		);
		const view = await readAppraisal(db, a);
		expect(view.brief).toBe('kept');
		expect(view.refs).toEqual([{ href: 'h', label: 'L' }]);
		expect(view.setAt).toEqual(NOW);
		expect(view.stamp?.appraisedAt).toEqual(new Date(NOW.getTime() + 1));
	});

	it('keeps a Link note on a re-add and reads Links in type order', async () => {
		const a = (await labour()).id;
		const b = (await labour()).id;
		await appraise(db, actor, [
			{
				labourId: a,
				links: [
					{ type: 'duplicates', to: b, note: 'd' },
					{ type: 'relates', from: b, note: 'r' },
					{ type: 'blocks', to: b, note: 'b' },
					{ type: 'evidence', to: b, note: 'e' }
				]
			}
		]);
		await appraise(db, actor, [{ labourId: a, links: [{ type: 'blocks', to: b }] }]);
		const read = await readLinks(db, b);
		expect(read.map((link) => [link.type, link.note])).toEqual([
			['evidence', 'e'],
			['blocks', 'b'],
			['relates', 'r'],
			['duplicates', 'd']
		]);
		expect(read[2]).toMatchObject({ from: Math.min(a, b), to: Math.max(a, b) });
	});
});
