import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { keywordScores, matchExpression } from './search.ts';

let db: Db;
let actor: Actor;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
});

afterEach(() => {
	db.$client.close();
});

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

type TextRow = {
	title: string;
	brief: string;
	description: string;
	comments: string;
	notes: string;
};

function textOf(labourId: number): TextRow | undefined {
	return db.$client
		.prepare('SELECT title, brief, description, comments, notes FROM labour_text WHERE rowid = ?')
		.get(labourId) as TextRow | undefined;
}

function indexedIds(): number[] {
	return (
		db.$client.prepare('SELECT rowid FROM labour_text ORDER BY rowid').all() as { rowid: number }[]
	).map((row) => row.rowid);
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
	it('has a row for a new Labour holding its title and description and nothing else', () => {
		const realm = seedRealm(db, 'AM');

		const labour = seedLabour(db, { realmId: realm.id, title: 'Boss HP', description: 'Too low' });

		expect(textOf(labour.id)).toEqual({
			title: 'Boss HP',
			brief: '',
			description: 'Too low',
			comments: '',
			notes: ''
		});
	});

	it('holds the title as stored, trimmed', () => {
		const realm = seedRealm(db, 'AM');

		const labour = seedLabour(db, { realmId: realm.id, title: '  Padded title  ' });

		expect(textOf(labour.id)?.title).toBe('Padded title');
	});

	it('gives every Labour exactly one row', () => {
		const realm = seedRealm(db, 'AM');
		const a = seedLabour(db, { realmId: realm.id });
		const b = seedLabour(db, { realmId: realm.id });
		updateLabour(db, actor, a.id, { title: 'Renamed' });
		addComment(db, actor, a.id, 'a comment');

		expect(indexedIds()).toEqual([a.id, b.id]);
	});

	it('follows a title change', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id, title: 'Old', description: 'Same' });

		updateLabour(db, actor, labour.id, { title: 'New' });

		expect(textOf(labour.id)).toMatchObject({ title: 'New', description: 'Same' });
	});

	it('follows a description change, including clearing it', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id, title: 'T', description: 'Old' });

		updateLabour(db, actor, labour.id, { description: 'New words' });
		expect(textOf(labour.id)).toMatchObject({ title: 'T', description: 'New words' });

		updateLabour(db, actor, labour.id, { description: '' });
		expect(textOf(labour.id)).toMatchObject({ title: 'T', description: '' });
	});

	it('is unchanged by an update that touches neither title nor description', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id, title: 'T', description: 'D' });
		addComment(db, actor, labour.id, 'kept');
		const before = textOf(labour.id);

		updateLabour(db, actor, labour.id, { labels: ['a-label'], assigneeId: seedUser(db, 'ada') });

		expect(textOf(labour.id)).toEqual(before);
	});

	it('is unchanged when an update is refused', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id, title: 'Old', description: 'Old body' });
		const before = textOf(labour.id);

		expectDomainError(
			() => updateLabour(db, actor, labour.id, { title: 'New', description: 'x'.repeat(50_001) }),
			'invalid'
		);
		expectDomainError(() => updateLabour(db, actor, labour.id, { title: '   ' }), 'invalid');

		expect(textOf(labour.id)).toEqual(before);
	});

	it('gains no row when creation is refused', () => {
		const realm = seedRealm(db, 'AM');
		const existing = seedLabour(db, { realmId: realm.id });

		expectDomainError(
			() =>
				createLabour(db, actor, { realmId: realm.id, title: '   ', ownerId: seedUser(db, 'ada') }),
			'invalid'
		);

		expect(indexedIds()).toEqual([existing.id]);
	});

	it('survives a move and a Realm key rename with its text intact', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const labour = seedLabour(db, { realmId: am.id, title: 'T', description: 'D' });
		addComment(db, actor, labour.id, 'c');
		const before = textOf(labour.id);

		moveLabour(db, actor, labour.id, { realmId: bl.id });
		renameRealmKey(db, actor, bl.id, 'BLX');

		expect(textOf(labour.id)).toEqual(before);
	});
});

describe('labour_text: Comments', () => {
	it('joins Comment bodies in id order with a blank line', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		const bob = { id: seedUser(db, 'bob') };

		addComment(db, actor, labour.id, 'first');
		addComment(db, bob, labour.id, 'second');
		addComment(db, actor, labour.id, 'third');

		expect(textOf(labour.id)?.comments).toBe('first\n\nsecond\n\nthird');
	});

	it('keeps one Labour Comments apart from another', () => {
		const realm = seedRealm(db, 'AM');
		const a = seedLabour(db, { realmId: realm.id });
		const b = seedLabour(db, { realmId: realm.id });

		addComment(db, actor, a.id, 'for a');

		expect(textOf(a.id)?.comments).toBe('for a');
		expect(textOf(b.id)?.comments).toBe('');
	});

	it('follows an edit in place', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		addComment(db, actor, labour.id, 'one');
		const two = addComment(db, actor, labour.id, 'two');
		addComment(db, actor, labour.id, 'three');

		editComment(db, actor, two.id, 'TWO, revised');

		expect(textOf(labour.id)?.comments).toBe('one\n\nTWO, revised\n\nthree');
	});

	it('drops a deleted Comment, and is empty again when none remain', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		const one = addComment(db, actor, labour.id, 'one');
		const two = addComment(db, actor, labour.id, 'two');
		const three = addComment(db, actor, labour.id, 'three');

		deleteComment(db, actor, two.id);
		expect(textOf(labour.id)?.comments).toBe('one\n\nthree');

		deleteComment(db, actor, one.id);
		deleteComment(db, actor, three.id);
		expect(textOf(labour.id)?.comments).toBe('');
	});

	it('is unchanged when a Comment write is refused', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		const mine = addComment(db, actor, labour.id, 'mine');
		const other = { id: seedUser(db, 'bob') };
		const before = textOf(labour.id);

		expectDomainError(() => addComment(db, actor, labour.id, '   '), 'invalid');
		expectDomainError(() => editComment(db, other, mine.id, 'hijacked'), 'forbidden');
		expectDomainError(() => deleteComment(db, other, mine.id), 'forbidden');

		expect(textOf(labour.id)).toEqual(before);
	});
});

describe('labour_text: Brief', () => {
	it('holds the Brief an appraisal writes, replaces it, and clears it with an empty one', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		appraise(db, actor, [{ labourId: labour.id, brief: 'Players dislike the boss HP' }]);
		expect(textOf(labour.id)?.brief).toBe('Players dislike the boss HP');

		appraise(db, actor, [{ labourId: labour.id, brief: 'Rewritten' }]);
		expect(textOf(labour.id)?.brief).toBe('Rewritten');

		appraise(db, actor, [{ labourId: labour.id, brief: '' }]);
		expect(textOf(labour.id)?.brief).toBe('');
	});

	it('is unchanged by an appraisal that does not name brief', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		appraise(db, actor, [{ labourId: labour.id, brief: 'kept' }]);

		appraise(db, actor, [
			{ labourId: labour.id, refs: [{ href: 'https://example.com/post', label: 'Post' }] }
		]);

		expect(textOf(labour.id)?.brief).toBe('kept');
	});

	it('updates every Labour in a batch', () => {
		const realm = seedRealm(db, 'AM');
		const a = seedLabour(db, { realmId: realm.id });
		const b = seedLabour(db, { realmId: realm.id });

		appraise(db, actor, [
			{ labourId: a.id, brief: 'brief a' },
			{ labourId: b.id, brief: 'brief b' }
		]);

		expect(textOf(a.id)?.brief).toBe('brief a');
		expect(textOf(b.id)?.brief).toBe('brief b');
	});

	it('leaves every row as it was when a later item refuses the batch', () => {
		const realm = seedRealm(db, 'AM');
		const a = seedLabour(db, { realmId: realm.id });
		const b = seedLabour(db, { realmId: realm.id });
		appraise(db, actor, [{ labourId: a.id, brief: 'old a' }]);
		const before = [textOf(a.id), textOf(b.id)];

		expectDomainError(
			() =>
				appraise(db, actor, [
					{ labourId: a.id, brief: 'new a' },
					{ labourId: b.id, brief: 'x'.repeat(401) }
				]),
			'invalid'
		);
		expectDomainError(
			() =>
				appraise(db, actor, [
					{ labourId: a.id, brief: 'new a' },
					{ labourId: 999_999, brief: 'ghost' }
				]),
			'not_found'
		);

		expect([textOf(a.id), textOf(b.id)]).toEqual(before);
	});
});

describe('labour_text: notes', () => {
	it('holds text values in Attribute position order, joined with a blank line', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		defineText(realm.id, 'repro');
		defineText(realm.id, 'context', 0);

		setValues(db, actor, labour.id, { repro: 'Open the map', context: 'Seen on stream' });

		expect(textOf(labour.id)?.notes).toBe('Seen on stream\n\nOpen the map');
	});

	it('holds a single value alone, trimmed, and ignores values of other kinds', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		defineText(realm.id, 'repro');
		defineAttribute(db, actor, realm.id, {
			key: 'severity',
			kind: 'scale',
			label: 'Severity',
			rubric: 'How bad',
			spec: { min: 1, max: 5 }
		});

		setValues(db, actor, labour.id, { repro: '  Open the map  ', severity: 4 });

		expect(textOf(labour.id)?.notes).toBe('Open the map');
	});

	it('follows a changed value and drops a cleared one', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		defineText(realm.id, 'repro');
		defineText(realm.id, 'context');
		setValues(db, actor, labour.id, { repro: 'one', context: 'two' });

		setValues(db, actor, labour.id, { repro: 'one, revised' });
		expect(textOf(labour.id)?.notes).toBe('one, revised\n\ntwo');

		setValues(db, actor, labour.id, { repro: null });
		expect(textOf(labour.id)?.notes).toBe('two');

		setValues(db, actor, labour.id, { context: '   ' });
		expect(textOf(labour.id)?.notes).toBe('');
	});

	it('keeps one Labour values apart from another', () => {
		const realm = seedRealm(db, 'AM');
		const a = seedLabour(db, { realmId: realm.id });
		const b = seedLabour(db, { realmId: realm.id });
		defineText(realm.id, 'repro');

		setValues(db, actor, a.id, { repro: 'only a' });

		expect(textOf(a.id)?.notes).toBe('only a');
		expect(textOf(b.id)?.notes).toBe('');
	});

	it('is unchanged when setValues refuses an entry', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		defineText(realm.id, 'repro');
		defineAttribute(db, actor, realm.id, {
			key: 'severity',
			kind: 'scale',
			label: 'Severity',
			rubric: 'How bad',
			spec: { min: 1, max: 5 }
		});
		setValues(db, actor, labour.id, { repro: 'old' });

		expectDomainError(
			() => setValues(db, actor, labour.id, { repro: 'new', severity: 99 }),
			'invalid'
		);

		expect(textOf(labour.id)?.notes).toBe('old');
	});

	it('follows the values of an appraisal', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		defineText(realm.id, 'repro');

		appraise(db, actor, [{ labourId: labour.id, values: { repro: 'from appraise' } }]);
		expect(textOf(labour.id)?.notes).toBe('from appraise');

		appraise(db, actor, [{ labourId: labour.id, values: { repro: null } }]);
		expect(textOf(labour.id)?.notes).toBe('');
	});

	it('leaves Brief and notes as they were when an appraisal batch is refused', () => {
		const realm = seedRealm(db, 'AM');
		const a = seedLabour(db, { realmId: realm.id });
		const b = seedLabour(db, { realmId: realm.id });
		defineText(realm.id, 'repro');
		appraise(db, actor, [{ labourId: a.id, brief: 'old', values: { repro: 'old note' } }]);
		const before = textOf(a.id);

		expectDomainError(
			() =>
				appraise(db, actor, [
					{ labourId: a.id, brief: 'new', values: { repro: 'new note' } },
					{ labourId: b.id, values: { nope: 'x' } }
				]),
			'invalid'
		);

		expect(textOf(a.id)).toEqual(before);
	});

	it('drops the values of a deleted text Attribute from every Labour that held it', () => {
		const realm = seedRealm(db, 'AM');
		const a = seedLabour(db, { realmId: realm.id });
		const b = seedLabour(db, { realmId: realm.id });
		const bystander = seedLabour(db, { realmId: realm.id });
		defineText(realm.id, 'repro');
		defineText(realm.id, 'context');
		setValues(db, actor, a.id, { repro: 'a repro', context: 'a context' });
		setValues(db, actor, b.id, { repro: 'b repro' });

		deleteAttribute(db, actor, realm.id, 'repro');

		expect(textOf(a.id)?.notes).toBe('a context');
		expect(textOf(b.id)?.notes).toBe('');
		expect(textOf(bystander.id)?.notes).toBe('');
	});

	it('is unchanged by deleting an Attribute of another kind', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		defineText(realm.id, 'repro');
		defineAttribute(db, actor, realm.id, {
			key: 'severity',
			kind: 'scale',
			label: 'Severity',
			rubric: 'How bad',
			spec: { min: 1, max: 5 }
		});
		setValues(db, actor, labour.id, { repro: 'kept', severity: 2 });

		deleteAttribute(db, actor, realm.id, 'severity');

		expect(textOf(labour.id)?.notes).toBe('kept');
	});

	it('drops a text value that does not carry over to the new Realm when the Labour moves', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const labour = seedLabour(db, { realmId: am.id, title: 'T' });
		defineText(am.id, 'repro');
		setValues(db, actor, labour.id, { repro: 'stays behind' });
		appraise(db, actor, [{ labourId: labour.id, brief: 'brief' }]);
		addComment(db, actor, labour.id, 'comment');

		moveLabour(db, actor, labour.id, { realmId: bl.id });

		expect(textOf(labour.id)).toEqual({
			title: 'T',
			brief: 'brief',
			description: '',
			comments: 'comment',
			notes: ''
		});
	});

	it('keeps a text value that carries over to the new Realm when the Labour moves', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const labour = seedLabour(db, { realmId: am.id });
		defineText(am.id, 'repro');
		defineText(bl.id, 'repro');
		defineText(am.id, 'context');
		setValues(db, actor, labour.id, { repro: 'travels', context: 'stays behind' });

		moveLabour(db, actor, labour.id, { realmId: bl.id });

		expect(textOf(labour.id)?.notes).toBe('travels');
	});
});

describe('labour_text: removal', () => {
	it('removes the row of a deleted Labour and leaves the others', () => {
		const realm = seedRealm(db, 'AM');
		const gone = seedLabour(db, { realmId: realm.id });
		const stays = seedLabour(db, { realmId: realm.id });

		deleteLabour(db, actor, gone.id);

		expect(indexedIds()).toEqual([stays.id]);
	});

	it('removes the rows of every Labour in a deleted Realm and no others', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const a1 = seedLabour(db, { realmId: am.id });
		const a2 = seedLabour(db, { realmId: am.id });
		const b1 = seedLabour(db, { realmId: bl.id });
		expect(indexedIds()).toEqual([a1.id, a2.id, b1.id]);

		deleteRealm(db, actor, am.id);

		expect(indexedIds()).toEqual([b1.id]);
	});

	it('stops a deleted Labour matching a search', () => {
		const realm = seedRealm(db, 'AM');
		const gone = seedLabour(db, { realmId: realm.id, title: 'Zebra stripes' });
		seedLabour(db, { realmId: realm.id, title: 'Zebra herd' });

		deleteLabour(db, actor, gone.id);

		expect([...keywordScores(db, 'zebra').keys()]).not.toContain(gone.id);
		expect(keywordScores(db, 'zebra').size).toBe(1);
	});
});

describe('matchExpression', () => {
	it.each([
		["boss-hp don't!", '"boss" OR "hp" OR "don" OR "t"'],
		['boss', '"boss"'],
		['boss hp', '"boss" OR "hp"'],
		['  spaced   out  ', '"spaced" OR "out"'],
		['foo_bar', '"foo" OR "bar"'],
		['v2 3d', '"v2" OR "3d"'],
		['café ñandú', '"café" OR "ñandú"'],
		['日本語 text', '"日本語" OR "text"'],
		['AND', '"AND"'],
		['NEAR(boss', '"NEAR" OR "boss"'],
		['title:boss', '"title" OR "boss"'],
		['say "hello"', '"say" OR "hello"'],
		['boss*', '"boss"']
	])('turns %j into %j', (query, expected) => {
		expect(matchExpression(query)).toBe(expected);
	});

	it.each([[''], ['   '], ['!!!'], ['"'], ["''"], ['*'], ['-_-'], ['()'], ['\n\t']])(
		'is null for %j, which holds no letter or digit',
		(query) => {
			expect(matchExpression(query)).toBeNull();
		}
	);

	it('never lets a quote from the query into the expression', () => {
		const expression = matchExpression('a"b" OR "c');

		expect(expression).toBe('"a" OR "b" OR "OR" OR "c"');
	});
});

describe('keywordScores', () => {
	function seedBoard() {
		const realm = seedRealm(db, 'AM');
		const ids = {
			sponges: seedLabour(db, { realmId: realm.id, title: 'Bosses feel like bullet sponges' }).id,
			telegraph: seedLabour(db, {
				realmId: realm.id,
				title: 'Telegraph feedback pass for boss wind-ups'
			}).id,
			inventory: seedLabour(db, { realmId: realm.id, title: 'Inventory sort button overlaps' }).id,
			oauth: seedLabour(db, { realmId: realm.id, title: 'OAuth token refresh' }).id
		};
		return { realm, ...ids };
	}

	it('finds the Labours that match and leaves out the ones that do not', () => {
		const board = seedBoard();

		const scores = keywordScores(db, 'boss');

		expect([...scores.keys()].sort()).toEqual([board.sponges, board.telegraph].sort());
		expect(scores.has(board.inventory)).toBe(false);
		expect(scores.has(board.oauth)).toBe(false);
	});

	it('scores the best match exactly 1 and the others as a share of it', () => {
		const board = seedBoard();

		const scores = keywordScores(db, 'boss');

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

	it('scores a lone match 1', () => {
		const board = seedBoard();

		expect(keywordScores(db, 'oauth')).toEqual(new Map([[board.oauth, 1]]));
	});

	it('is empty when nothing matches', () => {
		seedBoard();

		expect(keywordScores(db, 'zzzzqx').size).toBe(0);
	});

	it('ranks a title match above a description-only match for the same word', () => {
		const realm = seedRealm(db, 'AM');
		const inTitle = seedLabour(db, { realmId: realm.id, title: 'Dodge roll' });
		const inDescription = seedLabour(db, {
			realmId: realm.id,
			title: 'Camera shake',
			description: 'Dodge'
		});
		seedLabour(db, { realmId: realm.id, title: 'Inventory sort' });
		seedLabour(db, { realmId: realm.id, title: 'Token refresh' });
		seedLabour(db, { realmId: realm.id, title: 'Menu focus' });

		const scores = keywordScores(db, 'dodge');

		expect(scores.get(inTitle.id)).toBe(1);
		expect(scores.get(inDescription.id)).toBeGreaterThan(0);
		expect(scores.get(inDescription.id)).toBeLessThan(1);
	});

	it('ranks a Brief match above a description-only match', () => {
		const realm = seedRealm(db, 'AM');
		const inBrief = seedLabour(db, { realmId: realm.id, title: 'First' });
		const inDescription = seedLabour(db, {
			realmId: realm.id,
			title: 'Second',
			description: 'hitbox'
		});
		seedLabour(db, { realmId: realm.id, title: 'Third' });
		seedLabour(db, { realmId: realm.id, title: 'Fourth' });
		appraise(db, actor, [{ labourId: inBrief.id, brief: 'hitbox' }]);

		const scores = keywordScores(db, 'hitbox');

		expect(scores.get(inBrief.id)).toBe(1);
		expect(scores.get(inDescription.id)).toBeLessThan(1);
	});

	it('ranks a notes match above a Comment match', () => {
		const realm = seedRealm(db, 'AM');
		const inNotes = seedLabour(db, { realmId: realm.id, title: 'First' });
		const inComment = seedLabour(db, { realmId: realm.id, title: 'Second' });
		seedLabour(db, { realmId: realm.id, title: 'Third' });
		seedLabour(db, { realmId: realm.id, title: 'Fourth' });
		defineText(realm.id, 'repro');
		setValues(db, actor, inNotes.id, { repro: 'hitbox' });
		addComment(db, actor, inComment.id, 'hitbox');

		const scores = keywordScores(db, 'hitbox');

		expect(scores.get(inNotes.id)).toBe(1);
		expect(scores.get(inComment.id)).toBeLessThan(1);
	});

	it('ranks a Labour matching more of the query words above one matching fewer', () => {
		const realm = seedRealm(db, 'AM');
		const both = seedLabour(db, { realmId: realm.id, title: 'Chest loot respawn' });
		const one = seedLabour(db, { realmId: realm.id, title: 'Chest hinge' });
		seedLabour(db, { realmId: realm.id, title: 'Token refresh' });
		seedLabour(db, { realmId: realm.id, title: 'Menu focus' });

		const scores = keywordScores(db, 'chest respawn');

		expect(scores.get(both.id)).toBe(1);
		expect(scores.get(one.id)).toBeGreaterThan(0);
		expect(scores.get(one.id)).toBeLessThan(1);
	});

	it('stems words so a plural finds the singular and the reverse', () => {
		const realm = seedRealm(db, 'AM');
		const fight = seedLabour(db, { realmId: realm.id, title: 'Fix the fight camera' });
		const fights = seedLabour(db, { realmId: realm.id, title: 'Arena fights stutter' });
		seedLabour(db, { realmId: realm.id, title: 'Menu focus' });

		expect([...keywordScores(db, 'fights').keys()].sort()).toEqual([fight.id, fights.id].sort());
		expect([...keywordScores(db, 'fight').keys()].sort()).toEqual([fight.id, fights.id].sort());
		expect(keywordScores(db, 'fighting').has(fight.id)).toBe(true);
	});

	it('matches without regard to case', () => {
		const board = seedBoard();

		expect(keywordScores(db, 'OAUTH').has(board.oauth)).toBe(true);
		expect(keywordScores(db, 'oauth').has(board.oauth)).toBe(true);
	});

	it('searches the description, Comments, Brief and notes', () => {
		const realm = seedRealm(db, 'AM');
		const byDescription = seedLabour(db, {
			realmId: realm.id,
			title: 'One',
			description: 'quokka'
		});
		const byComment = seedLabour(db, { realmId: realm.id, title: 'Two' });
		const byBrief = seedLabour(db, { realmId: realm.id, title: 'Three' });
		const byNotes = seedLabour(db, { realmId: realm.id, title: 'Four' });
		seedLabour(db, { realmId: realm.id, title: 'Five' });
		defineText(realm.id, 'repro');
		addComment(db, actor, byComment.id, 'quokka');
		appraise(db, actor, [{ labourId: byBrief.id, brief: 'quokka' }]);
		setValues(db, actor, byNotes.id, { repro: 'quokka' });

		expect([...keywordScores(db, 'quokka').keys()].sort()).toEqual(
			[byDescription.id, byComment.id, byBrief.id, byNotes.id].sort()
		);
	});

	it('follows edits: the old word stops matching and the new one starts', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id, title: 'Giraffe neck' });
		const comment = addComment(db, actor, labour.id, 'ocelot sighting');

		updateLabour(db, actor, labour.id, { title: 'Hippo neck' });
		editComment(db, actor, comment.id, 'lemur sighting');

		expect(keywordScores(db, 'giraffe').size).toBe(0);
		expect(keywordScores(db, 'ocelot').size).toBe(0);
		expect(keywordScores(db, 'hippo').has(labour.id)).toBe(true);
		expect(keywordScores(db, 'lemur').has(labour.id)).toBe(true);
	});

	it('is empty for a query with no letter or digit', () => {
		seedBoard();

		expect(keywordScores(db, '').size).toBe(0);
		expect(keywordScores(db, '   ').size).toBe(0);
		expect(keywordScores(db, '!!!').size).toBe(0);
	});

	it('treats query punctuation as separators, not syntax', () => {
		const board = seedBoard();

		const scores = keywordScores(db, 'boss-hp');

		expect(scores.has(board.sponges)).toBe(true);
		expect(scores.has(board.telegraph)).toBe(true);
	});

	it('reads a query operator word as a plain word', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id, title: 'Save and load' });
		seedLabour(db, { realmId: realm.id, title: 'Menu focus' });

		expect(keywordScores(db, 'AND').has(labour.id)).toBe(true);
	});

	it('does not read a column filter in the query as a filter', () => {
		const realm = seedRealm(db, 'AM');
		const inDescription = seedLabour(db, {
			realmId: realm.id,
			title: 'One',
			description: 'needle'
		});
		seedLabour(db, { realmId: realm.id, title: 'Two' });

		expect(keywordScores(db, 'title:needle').has(inDescription.id)).toBe(true);
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
	])('never throws on %j', (query) => {
		seedBoard();

		const scores = keywordScores(db, query);

		expect(scores).toBeInstanceOf(Map);
		for (const [id, score] of scores) {
			expect(Number.isInteger(id)).toBe(true);
			expect(score).toBeGreaterThan(0);
			expect(score).toBeLessThanOrEqual(1);
		}
	});
});
