import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { addComment, deleteComment, editComment } from '#lib/server/domain/comments.ts';
import {
	createLabour,
	deleteLabour,
	moveLabour,
	updateLabour
} from '#lib/server/domain/labours.ts';
import { deleteRealm, renameRealmKey } from '#lib/server/domain/realms.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import { appraise } from './appraisals.ts';
import { defineAttribute, deleteAttribute, setValues } from './attributes.ts';
import { keywordScores, tsQuery } from './search.ts';

let db: Db;
let actor: Actor;

beforeEach(async () => {
	db = await testDb();
	actor = await seedActor(db);
});

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

type TextRow = {
	title: string;
	brief: string;
	description: string;
	comments: string;
	notes: string;
};

async function textOf(labourId: number): Promise<TextRow | undefined> {
	return (
		await db.$client.query<TextRow>(
			'SELECT title, brief, description, comments, notes FROM labour_text WHERE labour_id = $1',
			[labourId]
		)
	).rows[0];
}

async function indexedIds(): Promise<number[]> {
	return (
		await db.$client.query<{ labour_id: number }>(
			'SELECT labour_id FROM labour_text ORDER BY labour_id'
		)
	).rows.map((row) => row.labour_id);
}

const defineText = (realmId: number, key: string, index?: number) =>
	defineAttribute(db, actor, realmId, {
		key,
		kind: 'text',
		label: key,
		rubric: `What ${key} holds`,
		index
	});

describe('labour_text: Labour columns', () => {
	it('has a row for a new Labour holding its title and description and nothing else', async () => {
		const realm = await seedRealm(db, 'AM');

		const labour = await seedLabour(db, {
			realmId: realm.id,
			title: 'Boss HP',
			description: 'Too low'
		});

		expect(await textOf(labour.id)).toEqual({
			title: 'Boss HP',
			brief: '',
			description: 'Too low',
			comments: '',
			notes: ''
		});
	});

	it('holds the title as stored, trimmed', async () => {
		const realm = await seedRealm(db, 'AM');

		const labour = await seedLabour(db, { realmId: realm.id, title: '  Padded title  ' });

		expect((await textOf(labour.id))?.title).toBe('Padded title');
	});

	it('gives every Labour exactly one row', async () => {
		const realm = await seedRealm(db, 'AM');
		const a = await seedLabour(db, { realmId: realm.id });
		const b = await seedLabour(db, { realmId: realm.id });
		await updateLabour(db, actor, a.id, { title: 'Renamed' });
		await addComment(db, actor, a.id, 'a comment');

		expect(await indexedIds()).toEqual([a.id, b.id]);
	});

	it('follows a title change', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id, title: 'Old', description: 'Same' });

		await updateLabour(db, actor, labour.id, { title: 'New' });

		expect(await textOf(labour.id)).toMatchObject({ title: 'New', description: 'Same' });
	});

	it('follows a description change, including clearing it', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id, title: 'T', description: 'Old' });

		await updateLabour(db, actor, labour.id, { description: 'New words' });
		expect(await textOf(labour.id)).toMatchObject({ title: 'T', description: 'New words' });

		await updateLabour(db, actor, labour.id, { description: '' });
		expect(await textOf(labour.id)).toMatchObject({ title: 'T', description: '' });
	});

	it('is unchanged by an update that touches neither title nor description', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id, title: 'T', description: 'D' });
		await addComment(db, actor, labour.id, 'kept');
		const before = await textOf(labour.id);

		await updateLabour(db, actor, labour.id, {
			labels: ['a-label'],
			assigneeId: await seedUser(db, 'ada')
		});

		expect(await textOf(labour.id)).toEqual(before);
	});

	it('is unchanged when an update is refused', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, {
			realmId: realm.id,
			title: 'Old',
			description: 'Old body'
		});
		const before = await textOf(labour.id);

		await expectDomainError(
			() => updateLabour(db, actor, labour.id, { title: 'New', description: 'x'.repeat(50_001) }),
			'invalid'
		);
		await expectDomainError(() => updateLabour(db, actor, labour.id, { title: '   ' }), 'invalid');

		expect(await textOf(labour.id)).toEqual(before);
	});

	it('gains no row when creation is refused', async () => {
		const realm = await seedRealm(db, 'AM');
		const existing = await seedLabour(db, { realmId: realm.id });

		await expectDomainError(
			async () =>
				createLabour(db, actor, {
					realmId: realm.id,
					title: '   ',
					ownerId: await seedUser(db, 'ada')
				}),
			'invalid'
		);

		expect(await indexedIds()).toEqual([existing.id]);
	});

	it('survives a move and a Realm key rename with its text intact', async () => {
		const am = await seedRealm(db, 'AM');
		const bl = await seedRealm(db, 'BL');
		const labour = await seedLabour(db, { realmId: am.id, title: 'T', description: 'D' });
		await addComment(db, actor, labour.id, 'c');
		const before = await textOf(labour.id);

		await moveLabour(db, actor, labour.id, { realmId: bl.id });
		await renameRealmKey(db, actor, bl.id, 'BLX');

		expect(await textOf(labour.id)).toEqual(before);
	});
});

describe('labour_text: Comments', () => {
	it('joins Comment bodies in id order with a blank line', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });
		const bob = { id: await seedUser(db, 'bob') };

		await addComment(db, actor, labour.id, 'first');
		await addComment(db, bob, labour.id, 'second');
		await addComment(db, actor, labour.id, 'third');

		expect((await textOf(labour.id))?.comments).toBe('first\n\nsecond\n\nthird');
	});

	it('keeps one Labour Comments apart from another', async () => {
		const realm = await seedRealm(db, 'AM');
		const a = await seedLabour(db, { realmId: realm.id });
		const b = await seedLabour(db, { realmId: realm.id });

		await addComment(db, actor, a.id, 'for a');

		expect((await textOf(a.id))?.comments).toBe('for a');
		expect((await textOf(b.id))?.comments).toBe('');
	});

	it('follows an edit in place', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });
		await addComment(db, actor, labour.id, 'one');
		const two = await addComment(db, actor, labour.id, 'two');
		await addComment(db, actor, labour.id, 'three');

		await editComment(db, actor, two.id, 'TWO, revised');

		expect((await textOf(labour.id))?.comments).toBe('one\n\nTWO, revised\n\nthree');
	});

	it('drops a deleted Comment, and is empty again when none remain', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });
		const one = await addComment(db, actor, labour.id, 'one');
		const two = await addComment(db, actor, labour.id, 'two');
		const three = await addComment(db, actor, labour.id, 'three');

		await deleteComment(db, actor, two.id);
		expect((await textOf(labour.id))?.comments).toBe('one\n\nthree');

		await deleteComment(db, actor, one.id);
		await deleteComment(db, actor, three.id);
		expect((await textOf(labour.id))?.comments).toBe('');
	});

	it('is unchanged when a Comment write is refused', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });
		const mine = await addComment(db, actor, labour.id, 'mine');
		const other = { id: await seedUser(db, 'bob') };
		const before = await textOf(labour.id);

		await expectDomainError(() => addComment(db, actor, labour.id, '   '), 'invalid');
		await expectDomainError(() => editComment(db, other, mine.id, 'hijacked'), 'forbidden');
		await expectDomainError(() => deleteComment(db, other, mine.id), 'forbidden');

		expect(await textOf(labour.id)).toEqual(before);
	});
});

describe('labour_text: Brief', () => {
	it('holds the Brief an appraisal writes, replaces it, and clears it with an empty one', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });

		await appraise(db, actor, [{ labourId: labour.id, brief: 'Players dislike the boss HP' }]);
		expect((await textOf(labour.id))?.brief).toBe('Players dislike the boss HP');

		await appraise(db, actor, [{ labourId: labour.id, brief: 'Rewritten' }]);
		expect((await textOf(labour.id))?.brief).toBe('Rewritten');

		await appraise(db, actor, [{ labourId: labour.id, brief: '' }]);
		expect((await textOf(labour.id))?.brief).toBe('');
	});

	it('is unchanged by an appraisal that does not name brief', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });
		await appraise(db, actor, [{ labourId: labour.id, brief: 'kept' }]);

		await appraise(db, actor, [
			{ labourId: labour.id, refs: [{ href: 'https://example.com/post', label: 'Post' }] }
		]);

		expect((await textOf(labour.id))?.brief).toBe('kept');
	});

	it('updates every Labour in a batch', async () => {
		const realm = await seedRealm(db, 'AM');
		const a = await seedLabour(db, { realmId: realm.id });
		const b = await seedLabour(db, { realmId: realm.id });

		await appraise(db, actor, [
			{ labourId: a.id, brief: 'brief a' },
			{ labourId: b.id, brief: 'brief b' }
		]);

		expect((await textOf(a.id))?.brief).toBe('brief a');
		expect((await textOf(b.id))?.brief).toBe('brief b');
	});

	it('leaves every row as it was when a later item refuses the batch', async () => {
		const realm = await seedRealm(db, 'AM');
		const a = await seedLabour(db, { realmId: realm.id });
		const b = await seedLabour(db, { realmId: realm.id });
		await appraise(db, actor, [{ labourId: a.id, brief: 'old a' }]);
		const before = [await textOf(a.id), await textOf(b.id)];

		await expectDomainError(
			() =>
				appraise(db, actor, [
					{ labourId: a.id, brief: 'new a' },
					{ labourId: b.id, brief: 'x'.repeat(401) }
				]),
			'invalid'
		);
		await expectDomainError(
			() =>
				appraise(db, actor, [
					{ labourId: a.id, brief: 'new a' },
					{ labourId: 999_999, brief: 'ghost' }
				]),
			'not_found'
		);

		expect([await textOf(a.id), await textOf(b.id)]).toEqual(before);
	});
});

describe('labour_text: notes', () => {
	it('holds text values in Attribute position order, joined with a blank line', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });
		await defineText(realm.id, 'repro');
		await defineText(realm.id, 'context', 0);

		await setValues(db, actor, labour.id, { repro: 'Open the map', context: 'Seen on stream' });

		expect((await textOf(labour.id))?.notes).toBe('Seen on stream\n\nOpen the map');
	});

	it('holds a single value alone, trimmed, and ignores values of other kinds', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });
		await defineText(realm.id, 'repro');
		await defineAttribute(db, actor, realm.id, {
			key: 'severity',
			kind: 'scale',
			label: 'Severity',
			rubric: 'How bad',
			spec: { min: 1, max: 5 }
		});

		await setValues(db, actor, labour.id, { repro: '  Open the map  ', severity: 4 });

		expect((await textOf(labour.id))?.notes).toBe('Open the map');
	});

	it('follows a changed value and drops a cleared one', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });
		await defineText(realm.id, 'repro');
		await defineText(realm.id, 'context');
		await setValues(db, actor, labour.id, { repro: 'one', context: 'two' });

		await setValues(db, actor, labour.id, { repro: 'one, revised' });
		expect((await textOf(labour.id))?.notes).toBe('one, revised\n\ntwo');

		await setValues(db, actor, labour.id, { repro: null });
		expect((await textOf(labour.id))?.notes).toBe('two');

		await setValues(db, actor, labour.id, { context: '   ' });
		expect((await textOf(labour.id))?.notes).toBe('');
	});

	it('keeps one Labour values apart from another', async () => {
		const realm = await seedRealm(db, 'AM');
		const a = await seedLabour(db, { realmId: realm.id });
		const b = await seedLabour(db, { realmId: realm.id });
		await defineText(realm.id, 'repro');

		await setValues(db, actor, a.id, { repro: 'only a' });

		expect((await textOf(a.id))?.notes).toBe('only a');
		expect((await textOf(b.id))?.notes).toBe('');
	});

	it('is unchanged when setValues refuses an entry', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });
		await defineText(realm.id, 'repro');
		await defineAttribute(db, actor, realm.id, {
			key: 'severity',
			kind: 'scale',
			label: 'Severity',
			rubric: 'How bad',
			spec: { min: 1, max: 5 }
		});
		await setValues(db, actor, labour.id, { repro: 'old' });

		await expectDomainError(
			() => setValues(db, actor, labour.id, { repro: 'new', severity: 99 }),
			'invalid'
		);

		expect((await textOf(labour.id))?.notes).toBe('old');
	});

	it('follows the values of an appraisal', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });
		await defineText(realm.id, 'repro');

		await appraise(db, actor, [{ labourId: labour.id, values: { repro: 'from appraise' } }]);
		expect((await textOf(labour.id))?.notes).toBe('from appraise');

		await appraise(db, actor, [{ labourId: labour.id, values: { repro: null } }]);
		expect((await textOf(labour.id))?.notes).toBe('');
	});

	it('leaves Brief and notes as they were when an appraisal batch is refused', async () => {
		const realm = await seedRealm(db, 'AM');
		const a = await seedLabour(db, { realmId: realm.id });
		const b = await seedLabour(db, { realmId: realm.id });
		await defineText(realm.id, 'repro');
		await appraise(db, actor, [{ labourId: a.id, brief: 'old', values: { repro: 'old note' } }]);
		const before = await textOf(a.id);

		await expectDomainError(
			() =>
				appraise(db, actor, [
					{ labourId: a.id, brief: 'new', values: { repro: 'new note' } },
					{ labourId: b.id, values: { nope: 'x' } }
				]),
			'invalid'
		);

		expect(await textOf(a.id)).toEqual(before);
	});

	it('drops the values of a deleted text Attribute from every Labour that held it', async () => {
		const realm = await seedRealm(db, 'AM');
		const a = await seedLabour(db, { realmId: realm.id });
		const b = await seedLabour(db, { realmId: realm.id });
		const bystander = await seedLabour(db, { realmId: realm.id });
		await defineText(realm.id, 'repro');
		await defineText(realm.id, 'context');
		await setValues(db, actor, a.id, { repro: 'a repro', context: 'a context' });
		await setValues(db, actor, b.id, { repro: 'b repro' });

		await deleteAttribute(db, actor, realm.id, 'repro');

		expect((await textOf(a.id))?.notes).toBe('a context');
		expect((await textOf(b.id))?.notes).toBe('');
		expect((await textOf(bystander.id))?.notes).toBe('');
	});

	it('is unchanged by deleting an Attribute of another kind', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });
		await defineText(realm.id, 'repro');
		await defineAttribute(db, actor, realm.id, {
			key: 'severity',
			kind: 'scale',
			label: 'Severity',
			rubric: 'How bad',
			spec: { min: 1, max: 5 }
		});
		await setValues(db, actor, labour.id, { repro: 'kept', severity: 2 });

		await deleteAttribute(db, actor, realm.id, 'severity');

		expect((await textOf(labour.id))?.notes).toBe('kept');
	});

	it('drops a text value that does not carry over to the new Realm when the Labour moves', async () => {
		const am = await seedRealm(db, 'AM');
		const bl = await seedRealm(db, 'BL');
		const labour = await seedLabour(db, { realmId: am.id, title: 'T' });
		await defineText(am.id, 'repro');
		await setValues(db, actor, labour.id, { repro: 'stays behind' });
		await appraise(db, actor, [{ labourId: labour.id, brief: 'brief' }]);
		await addComment(db, actor, labour.id, 'comment');

		await moveLabour(db, actor, labour.id, { realmId: bl.id });

		expect(await textOf(labour.id)).toEqual({
			title: 'T',
			brief: 'brief',
			description: '',
			comments: 'comment',
			notes: ''
		});
	});

	it('keeps a text value that carries over to the new Realm when the Labour moves', async () => {
		const am = await seedRealm(db, 'AM');
		const bl = await seedRealm(db, 'BL');
		const labour = await seedLabour(db, { realmId: am.id });
		await defineText(am.id, 'repro');
		await defineText(bl.id, 'repro');
		await defineText(am.id, 'context');
		await setValues(db, actor, labour.id, { repro: 'travels', context: 'stays behind' });

		await moveLabour(db, actor, labour.id, { realmId: bl.id });

		expect((await textOf(labour.id))?.notes).toBe('travels');
	});
});

describe('labour_text: removal', () => {
	it('removes the row of a deleted Labour and leaves the others', async () => {
		const realm = await seedRealm(db, 'AM');
		const gone = await seedLabour(db, { realmId: realm.id });
		const stays = await seedLabour(db, { realmId: realm.id });

		await deleteLabour(db, actor, gone.id);

		expect(await indexedIds()).toEqual([stays.id]);
	});

	it('removes the rows of every Labour in a deleted Realm and no others', async () => {
		const am = await seedRealm(db, 'AM');
		const bl = await seedRealm(db, 'BL');
		const a1 = await seedLabour(db, { realmId: am.id });
		const a2 = await seedLabour(db, { realmId: am.id });
		const b1 = await seedLabour(db, { realmId: bl.id });
		expect(await indexedIds()).toEqual([a1.id, a2.id, b1.id]);

		await deleteRealm(db, actor, am.id);

		expect(await indexedIds()).toEqual([b1.id]);
	});

	it('stops a deleted Labour matching a search', async () => {
		const realm = await seedRealm(db, 'AM');
		const gone = await seedLabour(db, { realmId: realm.id, title: 'Zebra stripes' });
		await seedLabour(db, { realmId: realm.id, title: 'Zebra herd' });

		await deleteLabour(db, actor, gone.id);

		expect([...(await keywordScores(db, 'zebra')).keys()]).not.toContain(gone.id);
		expect((await keywordScores(db, 'zebra')).size).toBe(1);
	});
});

describe('tsQuery', () => {
	it.each([
		["boss-hp don't!", "'boss' | 'hp' | 'don' | 't'"],
		['boss', "'boss'"],
		['boss hp', "'boss' | 'hp'"],
		['  spaced   out  ', "'spaced' | 'out'"],
		['foo_bar', "'foo' | 'bar'"],
		['v2 3d', "'v2' | '3d'"],
		['café ñandú', "'café' | 'ñandú'"],
		['日本語 text', "'日本語' | 'text'"],
		['AND', "'AND'"],
		['NEAR(boss', "'NEAR' | 'boss'"],
		['title:boss', "'title' | 'boss'"],
		['say "hello"', "'say' | 'hello'"],
		['boss*', "'boss'"]
	])('turns %j into %j', (query, expected) => {
		expect(tsQuery(query)).toBe(expected);
	});

	it.each([[''], ['   '], ['!!!'], ['"'], ["''"], ['*'], ['-_-'], ['()'], ['\n\t']])(
		'is null for %j, which holds no letter or digit',
		(query) => {
			expect(tsQuery(query)).toBeNull();
		}
	);

	it('keeps the first 64 distinct terms and drops repeats', () => {
		const words = Array.from({ length: 20_000 }, (_, i) => `w${i % 100}`).join(' ');

		const terms = tsQuery(words)!.split(' | ');

		expect(terms).toHaveLength(64);
		expect(new Set(terms).size).toBe(64);
		expect(terms[0]).toBe("'w0'");
		expect(terms[63]).toBe("'w63'");
	});

	it('cuts a single huge word', () => {
		expect(tsQuery('x'.repeat(5000))).toBe(`'${'x'.repeat(64)}'`);
	});

	it('never lets a quote from the query into the expression', () => {
		const expression = tsQuery('a"b" OR "c');

		expect(expression).toBe("'a' | 'b' | 'OR' | 'c'");
	});
});

describe('keywordScores', () => {
	async function seedBoard() {
		const realm = await seedRealm(db, 'AM');
		const ids = {
			sponges: (
				await seedLabour(db, { realmId: realm.id, title: 'Bosses feel like bullet sponges' })
			).id,
			telegraph: (
				await seedLabour(db, {
					realmId: realm.id,
					title: 'Telegraph feedback pass for boss wind-ups'
				})
			).id,
			inventory: (
				await seedLabour(db, { realmId: realm.id, title: 'Inventory sort button overlaps' })
			).id,
			oauth: (await seedLabour(db, { realmId: realm.id, title: 'OAuth token refresh' })).id
		};
		return { realm, ...ids };
	}

	it('finds the Labours that match and leaves out the ones that do not', async () => {
		const board = await seedBoard();

		const scores = await keywordScores(db, 'boss');

		expect([...scores.keys()].sort()).toEqual([board.sponges, board.telegraph].sort());
		expect(scores.has(board.inventory)).toBe(false);
		expect(scores.has(board.oauth)).toBe(false);
	});

	it('scores the best match exactly 1 and the others as a share of it', async () => {
		const board = await seedBoard();

		const scores = await keywordScores(db, 'boss');

		expect(Math.max(...scores.values())).toBe(1);
		const lesser = [...scores.values()].filter((score) => score !== 1);
		expect(lesser.length).toBeGreaterThan(0);
		for (const score of lesser) {
			expect(score).toBeGreaterThan(0);
			expect(score).toBeLessThan(1);
		}
		expect(scores.get(board.sponges)).toBe(1);
		expect(scores.get(board.telegraph)).toBeLessThan(1);
	});

	it('scores a lone match 1', async () => {
		const board = await seedBoard();

		expect(await keywordScores(db, 'oauth')).toEqual(new Map([[board.oauth, 1]]));
	});

	it('is empty when nothing matches', async () => {
		await seedBoard();

		expect((await keywordScores(db, 'zzzzqx')).size).toBe(0);
	});

	it('ranks a title match above a description-only match for the same word', async () => {
		const realm = await seedRealm(db, 'AM');
		const inTitle = await seedLabour(db, { realmId: realm.id, title: 'Dodge roll' });
		const inDescription = await seedLabour(db, {
			realmId: realm.id,
			title: 'Camera shake',
			description: 'Dodge'
		});
		await seedLabour(db, { realmId: realm.id, title: 'Inventory sort' });
		await seedLabour(db, { realmId: realm.id, title: 'Token refresh' });
		await seedLabour(db, { realmId: realm.id, title: 'Menu focus' });

		const scores = await keywordScores(db, 'dodge');

		expect(scores.get(inTitle.id)).toBe(1);
		expect(scores.get(inDescription.id)).toBeGreaterThan(0);
		expect(scores.get(inDescription.id)).toBeLessThan(1);
	});

	it('ranks a Brief match above a description-only match', async () => {
		const realm = await seedRealm(db, 'AM');
		const inBrief = await seedLabour(db, { realmId: realm.id, title: 'First' });
		const inDescription = await seedLabour(db, {
			realmId: realm.id,
			title: 'Second',
			description: 'hitbox'
		});
		await seedLabour(db, { realmId: realm.id, title: 'Third' });
		await seedLabour(db, { realmId: realm.id, title: 'Fourth' });
		await appraise(db, actor, [{ labourId: inBrief.id, brief: 'hitbox' }]);

		const scores = await keywordScores(db, 'hitbox');

		expect(scores.get(inBrief.id)).toBe(1);
		expect(scores.get(inDescription.id)).toBeLessThan(1);
	});

	it('ranks a notes match above a Comment match', async () => {
		const realm = await seedRealm(db, 'AM');
		const inNotes = await seedLabour(db, { realmId: realm.id, title: 'First' });
		const inComment = await seedLabour(db, { realmId: realm.id, title: 'Second' });
		await seedLabour(db, { realmId: realm.id, title: 'Third' });
		await seedLabour(db, { realmId: realm.id, title: 'Fourth' });
		await defineText(realm.id, 'repro');
		await setValues(db, actor, inNotes.id, { repro: 'hitbox' });
		await addComment(db, actor, inComment.id, 'hitbox');

		const scores = await keywordScores(db, 'hitbox');

		expect(scores.get(inNotes.id)).toBe(1);
		expect(scores.get(inComment.id)).toBeLessThan(1);
	});

	it('ranks a Labour matching more of the query words above one matching fewer', async () => {
		const realm = await seedRealm(db, 'AM');
		const both = await seedLabour(db, { realmId: realm.id, title: 'Chest loot respawn' });
		const one = await seedLabour(db, { realmId: realm.id, title: 'Chest hinge' });
		await seedLabour(db, { realmId: realm.id, title: 'Token refresh' });
		await seedLabour(db, { realmId: realm.id, title: 'Menu focus' });

		const scores = await keywordScores(db, 'chest respawn');

		expect(scores.get(both.id)).toBe(1);
		expect(scores.get(one.id)).toBeGreaterThan(0);
		expect(scores.get(one.id)).toBeLessThan(1);
	});

	it('stems words so a plural finds the singular and the reverse', async () => {
		const realm = await seedRealm(db, 'AM');
		const fight = await seedLabour(db, { realmId: realm.id, title: 'Fix the fight camera' });
		const fights = await seedLabour(db, { realmId: realm.id, title: 'Arena fights stutter' });
		await seedLabour(db, { realmId: realm.id, title: 'Menu focus' });

		expect([...(await keywordScores(db, 'fights')).keys()].sort()).toEqual(
			[fight.id, fights.id].sort()
		);
		expect([...(await keywordScores(db, 'fight')).keys()].sort()).toEqual(
			[fight.id, fights.id].sort()
		);
		expect((await keywordScores(db, 'fighting')).has(fight.id)).toBe(true);
	});

	it('matches without regard to case', async () => {
		const board = await seedBoard();

		expect((await keywordScores(db, 'OAUTH')).has(board.oauth)).toBe(true);
		expect((await keywordScores(db, 'oauth')).has(board.oauth)).toBe(true);
	});

	it('searches the description, Comments, Brief and notes', async () => {
		const realm = await seedRealm(db, 'AM');
		const byDescription = await seedLabour(db, {
			realmId: realm.id,
			title: 'One',
			description: 'quokka'
		});
		const byComment = await seedLabour(db, { realmId: realm.id, title: 'Two' });
		const byBrief = await seedLabour(db, { realmId: realm.id, title: 'Three' });
		const byNotes = await seedLabour(db, { realmId: realm.id, title: 'Four' });
		await seedLabour(db, { realmId: realm.id, title: 'Five' });
		await defineText(realm.id, 'repro');
		await addComment(db, actor, byComment.id, 'quokka');
		await appraise(db, actor, [{ labourId: byBrief.id, brief: 'quokka' }]);
		await setValues(db, actor, byNotes.id, { repro: 'quokka' });

		expect([...(await keywordScores(db, 'quokka')).keys()].sort()).toEqual(
			[byDescription.id, byComment.id, byBrief.id, byNotes.id].sort()
		);
	});

	it('follows edits: the old word stops matching and the new one starts', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id, title: 'Giraffe neck' });
		const comment = await addComment(db, actor, labour.id, 'ocelot sighting');

		await updateLabour(db, actor, labour.id, { title: 'Hippo neck' });
		await editComment(db, actor, comment.id, 'lemur sighting');

		expect((await keywordScores(db, 'giraffe')).size).toBe(0);
		expect((await keywordScores(db, 'ocelot')).size).toBe(0);
		expect((await keywordScores(db, 'hippo')).has(labour.id)).toBe(true);
		expect((await keywordScores(db, 'lemur')).has(labour.id)).toBe(true);
	});

	it('is empty for a query with no letter or digit', async () => {
		await seedBoard();

		expect((await keywordScores(db, '')).size).toBe(0);
		expect((await keywordScores(db, '   ')).size).toBe(0);
		expect((await keywordScores(db, '!!!')).size).toBe(0);
	});

	it('treats query punctuation as separators, not syntax', async () => {
		const board = await seedBoard();

		const scores = await keywordScores(db, 'boss-hp');

		expect(scores.has(board.sponges)).toBe(true);
		expect(scores.has(board.telegraph)).toBe(true);
	});

	it('reads a query operator word as a plain word', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id, title: 'Save and load' });
		await seedLabour(db, { realmId: realm.id, title: 'Menu focus' });

		expect((await keywordScores(db, 'AND')).has(labour.id)).toBe(true);
	});

	it('does not read a column filter in the query as a filter', async () => {
		const realm = await seedRealm(db, 'AM');
		const inDescription = await seedLabour(db, {
			realmId: realm.id,
			title: 'One',
			description: 'needle'
		});
		await seedLabour(db, { realmId: realm.id, title: 'Two' });

		expect((await keywordScores(db, 'title:needle')).has(inDescription.id)).toBe(true);
	});

	it.each([
		['boss-hp'],
		["don't"],
		['"'],
		['AND'],
		['OR'],
		['NOT'],
		['NEAR('],
		['NEAR(boss hp, 2)'],
		['*'],
		['boss*'],
		["''"],
		['!!!'],
		['('],
		[')'],
		['^boss'],
		['title:'],
		['{title brief}: boss'],
		['boss AND'],
		['"unterminated'],
		['\\'],
		['a'.repeat(5000)]
	])('never throws on %j', async (query) => {
		await seedBoard();

		const scores = await keywordScores(db, query);

		expect(scores).toBeInstanceOf(Map);
		for (const [id, score] of scores) {
			expect(Number.isInteger(id)).toBe(true);
			expect(score).toBeGreaterThan(0);
			expect(score).toBeLessThanOrEqual(1);
		}
	});
});
