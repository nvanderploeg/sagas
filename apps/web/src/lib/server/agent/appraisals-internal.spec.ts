import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { appraisals, events, labours, links } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { deleteLabour } from '#lib/server/domain/labours.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm } from '#lib/server/test/fixtures.ts';
import { appraise, readAppraisal } from './appraisals.ts';
import { defineAttribute, readRealmAgent, readValues } from './attributes.ts';
import { contentHash } from './content.ts';
import { readLinks } from './links.ts';

let db: Db;
let actor: Actor;
let realmId: number;

const NOW = new Date('2026-03-01T00:00:00Z');

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
	realmId = seedRealm(db, 'AM').id;
});

afterEach(() => {
	db.$client.close();
});

function failure(action: () => unknown): DomainError {
	try {
		action();
	} catch (error) {
		if (error instanceof DomainError) return error;
		throw error;
	}
	throw new Error('expected a DomainError');
}

const labour = (over: Parameters<typeof seedLabour>[1] = { realmId }) => seedLabour(db, over);
const linkRows = () => db.select().from(links).all();
const appraisalRows = () => db.select().from(appraisals).all();

describe('schema', () => {
	const stamp = (over: Record<string, unknown>) =>
		db.$client
			.prepare(
				`INSERT INTO appraisals (labour_id, content_hash, appraised_by, appraised_at)
				 VALUES (@labour_id, @content_hash, @appraised_by, @appraised_at)`
			)
			.run({ labour_id: 0, content_hash: null, appraised_by: null, appraised_at: null, ...over });

	it('takes a stamp whole or not at all', () => {
		const { id } = labour();
		const by = actor.id;
		expect(() => stamp({ labour_id: id, content_hash: 'h' })).toThrow(/CHECK/);
		expect(() => stamp({ labour_id: id, appraised_by: by })).toThrow(/CHECK/);
		expect(() => stamp({ labour_id: id, appraised_at: 1 })).toThrow(/CHECK/);
		expect(() => stamp({ labour_id: id, content_hash: 'h', appraised_by: by })).toThrow(/CHECK/);
		expect(() =>
			stamp({ labour_id: id, content_hash: 'h', appraised_by: by, appraised_at: 1 })
		).not.toThrow();
	});

	it('allows a row with no setBy, setAt or stamp', () => {
		const { id } = labour();
		expect(() => stamp({ labour_id: id })).not.toThrow();
		expect(appraisalRows()[0]).toMatchObject({ brief: '', refs: [], setBy: null, setAt: null });
	});

	it('refuses refs that are not JSON', () => {
		const { id } = labour();
		const put = (refs: string) =>
			db.$client.prepare('INSERT INTO appraisals (labour_id, refs) VALUES (?, ?)').run(id, refs);
		expect(() => put('{nope')).toThrow(/CHECK/);
		expect(() => put('[]')).not.toThrow();
	});

	const put = (from: number, to: number, type = 'evidence') =>
		db.$client
			.prepare('INSERT INTO links (from_id, to_id, type, set_by, set_at) VALUES (?, ?, ?, ?, 0)')
			.run(from, to, type, actor.id);

	it('refuses a Link to itself, an unknown type and an unordered relates', () => {
		const a = labour().id;
		const b = labour().id;
		expect(() => put(a, a)).toThrow(/CHECK/);
		expect(() => put(a, b, 'mentions')).toThrow(/CHECK/);
		expect(() => put(b, a, 'relates')).toThrow(/CHECK/);
		expect(() => put(a, b, 'relates')).not.toThrow();
	});

	it('refuses a second Link of one type between two Labours and allows another type', () => {
		const a = labour().id;
		const b = labour().id;
		put(a, b, 'blocks');
		expect(() => put(a, b, 'blocks')).toThrow(/UNIQUE|PRIMARY/);
		expect(() => put(b, a, 'blocks')).not.toThrow();
		expect(() => put(a, b, 'evidence')).not.toThrow();
	});

	it('deletes an Appraisal with its Labour and a Link with either end', () => {
		const a = labour().id;
		const b = labour().id;
		const c = labour().id;
		appraise(db, actor, [
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
		expect(appraisalRows()).toHaveLength(2);
		expect(linkRows()).toHaveLength(2);

		deleteLabour(db, actor, c);
		expect(linkRows().map((row) => row.type)).toEqual(['evidence']);
		deleteLabour(db, actor, b);
		expect(linkRows()).toHaveLength(0);
		expect(appraisalRows().map((row) => row.labourId)).toEqual([a]);
		deleteLabour(db, actor, a);
		expect(appraisalRows()).toHaveLength(0);
	});

	it('deletes Appraisals and Links with their Realm', () => {
		const other = seedRealm(db, 'OT').id;
		const a = labour({ realmId: other }).id;
		const b = labour().id;
		appraise(db, actor, [{ labourId: a, brief: 'x', links: [{ type: 'relates', to: b }] }]);
		db.$client.prepare('DELETE FROM realms WHERE id = ?').run(other);
		expect(appraisalRows()).toHaveLength(0);
		expect(linkRows()).toHaveLength(0);
	});
});

describe('blocks cycles', () => {
	it('searches Links added earlier in the same batch', () => {
		const [a, b, c] = [labour(), labour(), labour()];
		const error = failure(() =>
			appraise(db, actor, [
				{ labourId: a.id, links: [{ type: 'blocks', to: b.id }] },
				{ labourId: b.id, links: [{ type: 'blocks', to: c.id }] },
				{ labourId: c.id, links: [{ type: 'blocks', to: a.id }] }
			])
		);
		expect(error.code).toBe('conflict');
		expect(error.message).toContain(c.key);
		expect(error.message).toContain(a.key);
		expect(linkRows()).toHaveLength(0);
	});

	it('finds a cycle named from the other end of the Link', () => {
		const [a, b, c] = [labour(), labour(), labour()];
		appraise(db, actor, [
			{ labourId: b.id, links: [{ type: 'blocks', from: a.id }] },
			{ labourId: c.id, links: [{ type: 'blocks', from: b.id }] }
		]);
		const error = failure(() =>
			appraise(db, actor, [{ labourId: a.id, links: [{ type: 'blocks', from: c.id }] }])
		);
		expect(error.code).toBe('conflict');
	});

	it('walks a long chain and a shortcut without looping', () => {
		const ids = Array.from({ length: 6 }, () => labour().id);
		appraise(
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
			failure(() =>
				appraise(db, actor, [{ labourId: ids[5]!, links: [{ type: 'blocks', to: ids[0]! }] }])
			).code
		).toBe('conflict');
		expect(() =>
			appraise(db, actor, [{ labourId: ids[0]!, links: [{ type: 'blocks', to: ids[5]! }] }])
		).not.toThrow();
	});

	it('lets other types close a loop and a removed Link reopen the way', () => {
		const a = labour().id;
		const b = labour().id;
		appraise(db, actor, [{ labourId: a, links: [{ type: 'blocks', to: b }] }]);
		appraise(db, actor, [{ labourId: b, links: [{ type: 'evidence', to: a }] }]);
		expect(
			failure(() => appraise(db, actor, [{ labourId: b, links: [{ type: 'blocks', to: a }] }])).code
		).toBe('conflict');
		appraise(db, actor, [{ labourId: a, links: [{ type: 'blocks', to: b, remove: true }] }]);
		expect(() =>
			appraise(db, actor, [{ labourId: b, links: [{ type: 'blocks', to: a }] }])
		).not.toThrow();
	});

	it('removes then re-adds in the opposite direction within one item', () => {
		const a = labour().id;
		const b = labour().id;
		appraise(db, actor, [{ labourId: a, links: [{ type: 'blocks', to: b }] }]);
		appraise(db, actor, [
			{
				labourId: a,
				links: [
					{ type: 'blocks', to: b, remove: true },
					{ type: 'blocks', from: b }
				]
			}
		]);
		expect(linkRows().map((row) => [row.fromId, row.toId])).toEqual([[b, a]]);
	});
});

describe('a batch is all or nothing', () => {
	it('undoes earlier items when a later one fails', () => {
		defineAttribute(db, actor, realmId, {
			key: 'size',
			kind: 'scale',
			label: 'Size',
			rubric: 'r',
			spec: { min: 1, max: 5 }
		});
		const before = readRealmAgent(db, realmId).version;
		const a = labour();
		const b = labour();
		const c = labour();
		const hash = contentHash(db, a.id);

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

		expect(failure(() => run({ labourId: 999_999, brief: 'x' })).code).toBe('not_found');
		expect(failure(() => run({ labourId: c.id, brief: 'x'.repeat(401) })).code).toBe('invalid');
		expect(failure(() => run({ labourId: c.id, values: { size: 9 } })).code).toBe('invalid');
		expect(failure(() => run({ labourId: c.id, links: [{ type: 'blocks', to: c.id }] })).code).toBe(
			'invalid'
		);

		expect(appraisalRows()).toHaveLength(0);
		expect(linkRows()).toHaveLength(0);
		expect(readValues(db, a.id)).toEqual([]);
		expect(readValues(db, b.id)).toEqual([]);
		expect(readRealmAgent(db, realmId).version).toBe(before);

		run({ labourId: c.id, brief: 'ok' });
		expect(appraisalRows()).toHaveLength(2);
		expect(readAppraisal(db, a.id).stamp?.contentHash).toBe(hash);
		expect(readRealmAgent(db, realmId).version).toBe(before + 1);
	});

	it('refuses a repeated Labour and a batch size outside 1 to 50 before writing', () => {
		const a = labour().id;
		const b = labour().id;
		expect(
			failure(() =>
				appraise(db, actor, [
					{ labourId: a, brief: 'x' },
					{ labourId: b, brief: 'y' },
					{ labourId: a, brief: 'z' }
				])
			).code
		).toBe('invalid');
		expect(failure(() => appraise(db, actor, [])).code).toBe('invalid');
		const many = Array.from({ length: 51 }, () => ({ labourId: labour().id, brief: 'x' }));
		expect(failure(() => appraise(db, actor, many)).code).toBe('invalid');
		expect(appraisalRows()).toHaveLength(0);
		expect(appraise(db, actor, many.slice(0, 50))).toHaveLength(50);
	});
});

describe('what appraise leaves alone', () => {
	it('records no Event and keeps updatedAt', () => {
		const a = labour();
		const b = labour();
		const eventsBefore = db.select().from(events).all().length;
		const updated = (id: number) =>
			db.select({ at: labours.updatedAt }).from(labours).where(eq(labours.id, id)).get()!.at;
		const stamps = [updated(a.id), updated(b.id)];

		appraise(
			db,
			actor,
			[
				{
					labourId: a.id,
					brief: 'x',
					refs: [{ href: 'h' }],
					links: [{ type: 'duplicates', to: b.id }],
					stamp: contentHash(db, a.id)
				}
			],
			new Date('2030-01-01T00:00:00Z')
		);

		expect(db.select().from(events).all()).toHaveLength(eventsBefore);
		expect([updated(a.id), updated(b.id)]).toEqual(stamps);
	});

	it('keeps the Brief when only the stamp is written', () => {
		const a = labour().id;
		appraise(db, actor, [{ labourId: a, brief: 'kept', refs: [{ href: 'h', label: 'L' }] }], NOW);
		appraise(db, actor, [{ labourId: a, stamp: contentHash(db, a) }], new Date(NOW.getTime() + 1));
		const view = readAppraisal(db, a);
		expect(view.brief).toBe('kept');
		expect(view.refs).toEqual([{ href: 'h', label: 'L' }]);
		expect(view.setAt).toEqual(NOW);
		expect(view.stamp?.appraisedAt).toEqual(new Date(NOW.getTime() + 1));
	});

	it('keeps a Link note on a re-add and reads Links in type order', () => {
		const a = labour().id;
		const b = labour().id;
		appraise(db, actor, [
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
		appraise(db, actor, [{ labourId: a, links: [{ type: 'blocks', to: b }] }]);
		const read = readLinks(db, b);
		expect(read.map((link) => [link.type, link.note])).toEqual([
			['evidence', 'e'],
			['blocks', 'b'],
			['relates', 'r'],
			['duplicates', 'd']
		]);
		expect(read[2]).toMatchObject({ from: Math.min(a, b), to: Math.max(a, b) });
	});
});
