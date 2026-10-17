import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { comments, derivedBuilds, mentions } from '#lib/server/db/schema.ts';
import { addComment, deleteComment, editComment } from '#lib/server/domain/comments.ts';
import {
	createLabour,
	deleteLabour,
	moveLabour,
	rankLabour,
	updateLabour
} from '#lib/server/domain/labours.ts';
import { deleteRealm } from '#lib/server/domain/realms.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import { appraise } from './appraisals.ts';
import { defineAttribute, deleteAttribute, setValues } from './attributes.ts';
import { DERIVED_VERSIONS, rebuildDerived } from './derived.ts';
import { readMentions } from './mentions.ts';
import { keywordScores, matchExpression } from './search.ts';

let db: Db;
let actor: Actor;
let realmId: number;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
	realmId = seedRealm(db, 'AM').id;
});

afterEach(() => {
	db.$client.close();
});

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

const textRows = () =>
	db.$client.prepare('SELECT count(*) FROM labour_text').pluck().get() as number;

const labour = (over: Partial<Parameters<typeof seedLabour>[1]> = {}) =>
	seedLabour(db, { realmId, ...over });

const textAttribute = (key: string, realm = realmId) =>
	defineAttribute(db, actor, realm, {
		key,
		kind: 'text',
		label: key,
		rubric: `what ${key} means`
	});

describe('labour_text hooks', () => {
	it('holds a new Labour', () => {
		const created = labour({ title: 'Boss HP', description: 'too high' });

		expect(textOf(created.id)).toEqual({
			title: 'Boss HP',
			brief: '',
			description: 'too high',
			comments: '',
			notes: ''
		});
	});

	it('follows a title or description change and ignores a rank-only one', () => {
		const a = labour({ title: 'first' });
		labour({ title: 'second' });

		updateLabour(db, actor, a.id, { title: 'renamed', description: 'details' });
		expect(textOf(a.id)).toMatchObject({ title: 'renamed', description: 'details' });

		db.$client.prepare('UPDATE labour_text SET title = ? WHERE rowid = ?').run('marker', a.id);
		rankLabour(db, actor, a.id, 'top');
		updateLabour(db, actor, a.id, { addLabels: ['bug'] });
		expect(textOf(a.id)!.title).toBe('marker');
	});

	it('joins Comments in id order and follows edits and deletes', () => {
		const target = labour();
		const first = addComment(db, actor, target.id, 'one');
		const second = addComment(db, actor, target.id, 'two');
		expect(textOf(target.id)!.comments).toBe('one\n\ntwo');

		editComment(db, actor, first.id, 'uno');
		expect(textOf(target.id)!.comments).toBe('uno\n\ntwo');

		deleteComment(db, actor, second.id);
		expect(textOf(target.id)!.comments).toBe('uno');
		deleteComment(db, actor, first.id);
		expect(textOf(target.id)!.comments).toBe('');
	});

	it('holds the Brief', () => {
		const target = labour();

		appraise(db, actor, [{ labourId: target.id, brief: 'a short read' }]);

		expect(textOf(target.id)!.brief).toBe('a short read');
	});

	it('holds text values in Attribute position order and drops them with their Attribute', () => {
		textAttribute('lore');
		textAttribute('intent');
		defineAttribute(db, actor, realmId, { key: 'intent', kind: 'text', index: 0 });
		const target = labour();

		setValues(db, actor, target.id, { lore: 'old tale', intent: 'make it hard' });
		expect(textOf(target.id)!.notes).toBe('make it hard\n\nold tale');

		defineAttribute(db, actor, realmId, { key: 'lore', kind: 'text', index: 0 });
		expect(textOf(target.id)!.notes).toBe('old tale\n\nmake it hard');

		setValues(db, actor, target.id, { lore: null });
		expect(textOf(target.id)!.notes).toBe('make it hard');

		deleteAttribute(db, actor, realmId, 'intent');
		expect(textOf(target.id)!.notes).toBe('');
	});

	it('leaves other Labours alone when a text Attribute goes', () => {
		textAttribute('lore');
		const holder = labour();
		const other = labour();
		setValues(db, actor, holder.id, { lore: 'tale' });
		db.$client.prepare('UPDATE labour_text SET notes = ? WHERE rowid = ?').run('marker', other.id);

		deleteAttribute(db, actor, realmId, 'lore');

		expect(textOf(holder.id)!.notes).toBe('');
		expect(textOf(other.id)!.notes).toBe('marker');
	});

	it('drops a text value that does not carry to the new Realm', () => {
		textAttribute('lore');
		const target = labour();
		setValues(db, actor, target.id, { lore: 'tale' });
		const elsewhere = seedRealm(db, 'BL').id;

		moveLabour(db, actor, target.id, { realmId: elsewhere });

		expect(textOf(target.id)!.notes).toBe('');
	});

	it('keeps a text value that carries to the new Realm', () => {
		textAttribute('lore');
		const elsewhere = seedRealm(db, 'BL').id;
		textAttribute('lore', elsewhere);
		const target = labour();
		setValues(db, actor, target.id, { lore: 'tale' });

		moveLabour(db, actor, target.id, { realmId: elsewhere });

		expect(textOf(target.id)!.notes).toBe('tale');
	});

	it('removes the row of a deleted Labour and of every Labour in a deleted Realm', () => {
		const solo = labour();
		const other = seedRealm(db, 'BL').id;
		const kept = labour({ realmId: other });
		labour();
		labour();

		deleteLabour(db, actor, solo.id);
		expect(textOf(solo.id)).toBeUndefined();

		deleteRealm(db, actor, realmId);
		expect(textRows()).toBe(1);
		expect(textOf(kept.id)).toBeDefined();
	});

	it('leaves the row as it was when the write rolls back', () => {
		const target = labour();
		appraise(db, actor, [{ labourId: target.id, brief: 'before' }]);

		expect(() =>
			appraise(db, actor, [
				{ labourId: target.id, brief: 'after' },
				{ labourId: target.id + 999, brief: 'x' }
			])
		).toThrow();
		expect(() => addComment(db, actor, target.id, '')).toThrow();

		expect(textOf(target.id)).toMatchObject({ brief: 'before', comments: '' });
		expect(keywordScores(db, 'after').size).toBe(0);
	});
});

describe('Mention hooks', () => {
	const rows = () => db.select().from(mentions).all();

	it('records a description Mention with the acting User and the creation time', () => {
		const target = labour();
		const other = { id: seedUser(db, 'ada') };

		const source = createLabour(db, other, {
			realmId,
			title: 'src',
			ownerId: actor.id,
			description: `see ${target.key} and @actor`
		});

		expect(
			rows().map((r) => [r.sourceLabourId, r.commentId, r.labourId, r.userId, r.authorId])
		).toEqual([
			[source.id, null, target.id, null, other.id],
			[source.id, null, null, actor.id, other.id]
		]);
		expect(rows()[0].firstSeenAt).toEqual(source.createdAt);
	});

	it('keeps a surviving row, adds new ones at the update time and drops the rest', () => {
		const a = labour();
		const b = labour();
		const other = { id: seedUser(db, 'ada') };
		const source = labour({ description: `${a.key}` });
		const [kept] = rows();

		const updated = updateLabour(db, other, source.id, { description: `${a.key} ${b.key}` });

		const byTarget = new Map(rows().map((r) => [r.labourId, r]));
		expect(byTarget.get(a.id)).toEqual(kept);
		expect(byTarget.get(b.id)).toMatchObject({
			authorId: other.id,
			firstSeenAt: updated.updatedAt
		});

		updateLabour(db, other, source.id, { description: b.key.toLowerCase() });
		expect(rows().map((r) => r.labourId)).toEqual([b.id]);
	});

	it('leaves Mentions alone on a title-only change', () => {
		const a = labour();
		const source = labour({ description: a.key });
		const before = rows();

		updateLabour(db, actor, source.id, { title: 'new title' });

		expect(rows()).toEqual(before);
	});

	it('refreshes a Comment on add and edit, and drops it with the Comment', () => {
		const a = labour();
		const b = labour();
		const source = labour();
		const commentator = { id: seedUser(db, 'ada') };

		const comment = addComment(db, commentator, source.id, `cf ${a.key}`);
		expect(rows()).toMatchObject([
			{ commentId: comment.id, labourId: a.id, authorId: commentator.id }
		]);
		expect(rows()[0].firstSeenAt).toEqual(comment.createdAt);

		const edited = editComment(db, commentator, comment.id, `cf ${a.key} ${b.key}`);
		expect(rows().find((r) => r.labourId === b.id)!.firstSeenAt).toEqual(edited.updatedAt);

		deleteComment(db, commentator, comment.id);
		expect(rows()).toEqual([]);
	});

	it('resolves a former key and skips a Labour naming itself', () => {
		const moved = labour();
		const former = moved.key;
		moveLabour(db, actor, moved.id, { realmId: seedRealm(db, 'BL').id });
		const source = labour({ description: `${former} ${'AM-' + 999}` });
		addComment(db, actor, moved.id, `${former} is me`);

		expect(rows().map((r) => [r.sourceLabourId, r.labourId])).toEqual([[source.id, moved.id]]);
	});

	it('deletes Mentions with their source or target Labour', () => {
		const target = labour();
		const source = labour({ description: target.key });
		expect(rows()).toHaveLength(1);

		deleteLabour(db, actor, target.id);
		expect(rows()).toEqual([]);

		const next = labour();
		const again = labour({ description: next.key });
		deleteLabour(db, actor, again.id);
		expect(rows()).toEqual([]);
		expect(source.id).not.toBe(again.id);
	});

	it('reads the newest ten, ties by higher id', () => {
		const target = labour();
		for (let i = 0; i < 12; i += 1) labour({ description: target.key });

		const seen = readMentions(db, target.id);

		expect(seen).toHaveLength(10);
		const ids = seen.map((m) => m.sourceLabourId);
		expect(ids).toEqual([...ids].sort((x, y) => y - x));
	});
});

describe('mentions table', () => {
	const insert = (over: Record<string, unknown>) =>
		db.$client
			.prepare(
				`INSERT INTO mentions (source_labour_id, comment_id, labour_id, user_id, author_id, first_seen_at)
				 VALUES (@source, @comment, @labour, @user, @author, 1)`
			)
			.run({ source: 0, comment: null, labour: null, user: null, author: actor.id, ...over });

	it('refuses a second row for the same text and target, null comment included', () => {
		const [a, b] = [labour(), labour()];
		insert({ source: a.id, labour: b.id });
		expect(() => insert({ source: a.id, labour: b.id })).toThrow(/UNIQUE/);
		insert({ source: a.id, user: actor.id });
		expect(() => insert({ source: a.id, user: actor.id })).toThrow(/UNIQUE/);

		const comment = db
			.insert(comments)
			.values({ labourId: a.id, authorId: actor.id, body: 'x' })
			.returning()
			.get();
		insert({ source: a.id, comment: comment.id, labour: b.id });
		expect(() => insert({ source: a.id, comment: comment.id, labour: b.id })).toThrow(/UNIQUE/);
	});

	it('takes exactly one target that is not the source', () => {
		const a = labour();
		expect(() => insert({ source: a.id })).toThrow(/CHECK/);
		expect(() => insert({ source: a.id, labour: a.id })).toThrow(/CHECK/);
		expect(() => insert({ source: a.id, labour: labour().id, user: actor.id })).toThrow(/CHECK/);
	});
});

describe('search', () => {
	it('turns any text into a safe expression', () => {
		expect(matchExpression("boss-hp don't!")).toBe('"boss" OR "hp" OR "don" OR "t"');
		expect(matchExpression('  -- ""  ')).toBeNull();
		expect(keywordScores(db, 'AND OR NOT "unbalanced (*').size).toBe(0);
		expect(keywordScores(db, '***').size).toBe(0);
	});

	it('scores the best match 1 and stems', () => {
		const strong = labour({ title: 'dragons dragons' });
		const weak = labour({ description: 'a dragon sleeps' });
		labour({ title: 'unrelated' });

		const scores = keywordScores(db, 'dragon');

		expect(scores.get(strong.id)).toBe(1);
		expect(scores.get(weak.id)).toBeGreaterThan(0);
		expect(scores.get(weak.id)).toBeLessThan(1);
		expect(scores.size).toBe(2);
	});
});

describe('rebuildDerived', () => {
	it('builds every structure once and records them', () => {
		const now = new Date('2026-05-01T00:00:00Z');

		expect(rebuildDerived(db, now)).toEqual(['labour_text', 'mentions', 'embedding_inputs']);
		expect(rebuildDerived(db, now)).toEqual([]);
		expect(db.select().from(derivedBuilds).all()).toEqual([
			{ name: 'labour_text', version: DERIVED_VERSIONS.labour_text, builtAt: now },
			{ name: 'mentions', version: DERIVED_VERSIONS.mentions, builtAt: now },
			{ name: 'embedding_inputs', version: DERIVED_VERSIONS.embedding_inputs, builtAt: now }
		]);
	});

	it('rebuilds a structure whose stored version is behind', () => {
		rebuildDerived(db);
		db.update(derivedBuilds).set({ version: 0 }).where(eq(derivedBuilds.name, 'mentions')).run();

		expect(rebuildDerived(db)).toEqual(['mentions']);
	});

	it('restores wiped rows, keeping surviving Mentions and seeding new ones from the text', () => {
		const target = labour();
		const owner = seedUser(db, 'ada');
		const source = labour({ ownerId: owner, description: `${target.key} @ada` });
		const comment = addComment(db, actor, source.id, `again ${target.key}`);
		const kept = db.select().from(mentions).all();
		db.delete(mentions).where(eq(mentions.userId, owner)).run();
		db.$client.prepare('DELETE FROM labour_text').run();

		db.delete(derivedBuilds).run();
		rebuildDerived(db);

		expect(textOf(source.id)).toMatchObject({
			description: `${target.key} @ada`,
			comments: `again ${target.key}`
		});
		const after = db.select().from(mentions).all();
		expect(after).toHaveLength(kept.length);
		const seeded = after.find((r) => r.userId === owner)!;
		expect(seeded).toMatchObject({
			commentId: null,
			authorId: owner,
			firstSeenAt: source.createdAt
		});
		expect(after.find((r) => r.commentId === comment.id)).toMatchObject({
			authorId: actor.id,
			firstSeenAt: comment.createdAt
		});
	});

	it('rebuilds 2,000 Labours in good time', () => {
		const owner = seedUser(db, 'bulk');
		const first = labour({ ownerId: owner });
		for (let i = 0; i < 1999; i += 1) {
			createLabour(db, actor, {
				realmId,
				title: `Labour ${i}`,
				ownerId: owner,
				description: `see ${first.key} and @bulk about dragons`
			});
		}
		db.$client.prepare('DELETE FROM labour_text').run();
		db.delete(mentions).run();

		const started = performance.now();
		rebuildDerived(db);
		const took = performance.now() - started;

		expect(textRows()).toBe(2000);
		expect(db.select().from(mentions).all()).toHaveLength(3998);
		expect(took).toBeLessThan(5000);
	}, 60_000);
});
