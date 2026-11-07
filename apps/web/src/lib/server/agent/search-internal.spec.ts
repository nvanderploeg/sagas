import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
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
import { testDb, expectFailure } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import { appraise } from './appraisals.ts';
import { defineAttribute, deleteAttribute, setValues } from './attributes.ts';
import { DERIVED_VERSIONS, rebuildDerived } from './derived.ts';
import { readMentions } from './mentions.ts';
import { keywordScores, tsQuery } from './search.ts';

let db: Db;
let actor: Actor;
let realmId: number;

beforeEach(async () => {
	db = await testDb();
	actor = await seedActor(db);
	realmId = (await seedRealm(db, 'AM')).id;
});

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

const textRows = async () =>
	(await db.$client.query<{ n: number }>('SELECT count(*) AS n FROM labour_text')).rows[0].n;

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
	it('holds a new Labour', async () => {
		const created = await labour({ title: 'Boss HP', description: 'too high' });

		expect(await textOf(created.id)).toEqual({
			title: 'Boss HP',
			brief: '',
			description: 'too high',
			comments: '',
			notes: ''
		});
	});

	it('follows a title or description change and ignores a rank-only one', async () => {
		const a = await labour({ title: 'first' });
		await labour({ title: 'second' });

		await updateLabour(db, actor, a.id, { title: 'renamed', description: 'details' });
		expect(await textOf(a.id)).toMatchObject({ title: 'renamed', description: 'details' });

		await db.$client.query('UPDATE labour_text SET title = $1 WHERE labour_id = $2', [
			'marker',
			a.id
		]);
		await rankLabour(db, actor, a.id, 'top');
		await updateLabour(db, actor, a.id, { addLabels: ['bug'] });
		expect((await textOf(a.id))!.title).toBe('marker');
	});

	it('joins Comments in id order and follows edits and deletes', async () => {
		const target = await labour();
		const first = await addComment(db, actor, target.id, 'one');
		const second = await addComment(db, actor, target.id, 'two');
		expect((await textOf(target.id))!.comments).toBe('one\n\ntwo');

		await editComment(db, actor, first.id, 'uno');
		expect((await textOf(target.id))!.comments).toBe('uno\n\ntwo');

		await deleteComment(db, actor, second.id);
		expect((await textOf(target.id))!.comments).toBe('uno');
		await deleteComment(db, actor, first.id);
		expect((await textOf(target.id))!.comments).toBe('');
	});

	it('holds the Brief', async () => {
		const target = await labour();

		await appraise(db, actor, [{ labourId: target.id, brief: 'a short read' }]);

		expect((await textOf(target.id))!.brief).toBe('a short read');
	});

	it('holds text values in Attribute position order and drops them with their Attribute', async () => {
		await textAttribute('lore');
		await textAttribute('intent');
		await defineAttribute(db, actor, realmId, { key: 'intent', kind: 'text', index: 0 });
		const target = await labour();

		await setValues(db, actor, target.id, { lore: 'old tale', intent: 'make it hard' });
		expect((await textOf(target.id))!.notes).toBe('make it hard\n\nold tale');

		await defineAttribute(db, actor, realmId, { key: 'lore', kind: 'text', index: 0 });
		expect((await textOf(target.id))!.notes).toBe('old tale\n\nmake it hard');

		await setValues(db, actor, target.id, { lore: null });
		expect((await textOf(target.id))!.notes).toBe('make it hard');

		await deleteAttribute(db, actor, realmId, 'intent');
		expect((await textOf(target.id))!.notes).toBe('');
	});

	it('leaves other Labours alone when a text Attribute goes', async () => {
		await textAttribute('lore');
		const holder = await labour();
		const other = await labour();
		await setValues(db, actor, holder.id, { lore: 'tale' });
		await db.$client.query('UPDATE labour_text SET notes = $1 WHERE labour_id = $2', [
			'marker',
			other.id
		]);

		await deleteAttribute(db, actor, realmId, 'lore');

		expect((await textOf(holder.id))!.notes).toBe('');
		expect((await textOf(other.id))!.notes).toBe('marker');
	});

	it('drops a text value that does not carry to the new Realm', async () => {
		await textAttribute('lore');
		const target = await labour();
		await setValues(db, actor, target.id, { lore: 'tale' });
		const elsewhere = (await seedRealm(db, 'BL')).id;

		await moveLabour(db, actor, target.id, { realmId: elsewhere });

		expect((await textOf(target.id))!.notes).toBe('');
	});

	it('keeps a text value that carries to the new Realm', async () => {
		await textAttribute('lore');
		const elsewhere = (await seedRealm(db, 'BL')).id;
		await textAttribute('lore', elsewhere);
		const target = await labour();
		await setValues(db, actor, target.id, { lore: 'tale' });

		await moveLabour(db, actor, target.id, { realmId: elsewhere });

		expect((await textOf(target.id))!.notes).toBe('tale');
	});

	it('removes the row of a deleted Labour and of every Labour in a deleted Realm', async () => {
		const solo = await labour();
		const other = (await seedRealm(db, 'BL')).id;
		const kept = await labour({ realmId: other });
		await labour();
		await labour();

		await deleteLabour(db, actor, solo.id);
		expect(await textOf(solo.id)).toBeUndefined();

		await deleteRealm(db, actor, realmId);
		expect(await textRows()).toBe(1);
		expect(await textOf(kept.id)).toBeDefined();
	});

	it('leaves the row as it was when the write rolls back', async () => {
		const target = await labour();
		await appraise(db, actor, [{ labourId: target.id, brief: 'before' }]);

		await expect(
			appraise(db, actor, [
				{ labourId: target.id, brief: 'after' },
				{ labourId: target.id + 999, brief: 'x' }
			])
		).rejects.toThrow();
		await expect(addComment(db, actor, target.id, '')).rejects.toThrow();

		expect(await textOf(target.id)).toMatchObject({ brief: 'before', comments: '' });
		expect((await keywordScores(db, 'after')).size).toBe(0);
	});
});

describe('Mention hooks', () => {
	const rows = async () => await db.select().from(mentions);

	it('records a description Mention with the acting User and the creation time', async () => {
		const target = await labour();
		const other = { id: await seedUser(db, 'ada') };

		const source = await createLabour(db, other, {
			realmId,
			title: 'src',
			ownerId: actor.id,
			description: `see ${target.key} and @actor`
		});

		expect(
			(await rows()).map((r) => [r.sourceLabourId, r.commentId, r.labourId, r.userId, r.authorId])
		).toEqual([
			[source.id, null, target.id, null, other.id],
			[source.id, null, null, actor.id, other.id]
		]);
		expect((await rows())[0].firstSeenAt).toEqual(source.createdAt);
	});

	it('keeps a surviving row, adds new ones at the update time and drops the rest', async () => {
		const a = await labour();
		const b = await labour();
		const other = { id: await seedUser(db, 'ada') };
		const source = await labour({ description: `${a.key}` });
		const [kept] = await rows();

		const updated = await updateLabour(db, other, source.id, { description: `${a.key} ${b.key}` });

		const byTarget = new Map((await rows()).map((r) => [r.labourId, r]));
		expect(byTarget.get(a.id)).toEqual(kept);
		expect(byTarget.get(b.id)).toMatchObject({
			authorId: other.id,
			firstSeenAt: updated.updatedAt
		});

		await updateLabour(db, other, source.id, { description: b.key.toLowerCase() });
		expect((await rows()).map((r) => r.labourId)).toEqual([b.id]);
	});

	it('leaves Mentions alone on a title-only change', async () => {
		const a = await labour();
		const source = await labour({ description: a.key });
		const before = await rows();

		await updateLabour(db, actor, source.id, { title: 'new title' });

		expect(await rows()).toEqual(before);
	});

	it('refreshes a Comment on add and edit, and drops it with the Comment', async () => {
		const a = await labour();
		const b = await labour();
		const source = await labour();
		const commentator = { id: await seedUser(db, 'ada') };

		const comment = await addComment(db, commentator, source.id, `cf ${a.key}`);
		expect(await rows()).toMatchObject([
			{ commentId: comment.id, labourId: a.id, authorId: commentator.id }
		]);
		expect((await rows())[0].firstSeenAt).toEqual(comment.createdAt);

		const edited = await editComment(db, commentator, comment.id, `cf ${a.key} ${b.key}`);
		expect((await rows()).find((r) => r.labourId === b.id)!.firstSeenAt).toEqual(edited.updatedAt);

		await deleteComment(db, commentator, comment.id);
		expect(await rows()).toEqual([]);
	});

	it('resolves a former key and skips a Labour naming itself', async () => {
		const moved = await labour();
		const former = moved.key;
		await moveLabour(db, actor, moved.id, { realmId: (await seedRealm(db, 'BL')).id });
		const source = await labour({ description: `${former} ${'AM-' + 999}` });
		await addComment(db, actor, moved.id, `${former} is me`);

		expect((await rows()).map((r) => [r.sourceLabourId, r.labourId])).toEqual([
			[source.id, moved.id]
		]);
	});

	it('deletes Mentions with their source or target Labour', async () => {
		const target = await labour();
		const source = await labour({ description: target.key });
		expect(await rows()).toHaveLength(1);

		await deleteLabour(db, actor, target.id);
		expect(await rows()).toEqual([]);

		const next = await labour();
		const again = await labour({ description: next.key });
		await deleteLabour(db, actor, again.id);
		expect(await rows()).toEqual([]);
		expect(source.id).not.toBe(again.id);
	});

	it('reads the newest ten, ties by higher id', async () => {
		const target = await labour();
		for (let i = 0; i < 12; i += 1) await labour({ description: target.key });

		const seen = await readMentions(db, target.id);

		expect(seen).toHaveLength(10);
		const ids = seen.map((m) => m.sourceLabourId);
		expect(ids).toEqual([...ids].sort((x, y) => y - x));
	});
});

describe('mentions table', () => {
	const insert = (over: Record<string, unknown>) => {
		const row = { source: 0, comment: null, labour: null, user: null, author: actor.id, ...over };
		return db.$client.query(
			`INSERT INTO mentions (source_labour_id, comment_id, labour_id, user_id, author_id, first_seen_at)
			 VALUES ($1, $2, $3, $4, $5, 1)`,
			[row.source, row.comment, row.labour, row.user, row.author]
		);
	};

	it('refuses a second row for the same text and target, null comment included', async () => {
		const [a, b] = [await labour(), await labour()];
		await insert({ source: a.id, labour: b.id });
		await expectFailure(insert({ source: a.id, labour: b.id }), /mentions_source_target_uq/);
		await insert({ source: a.id, user: actor.id });
		await expectFailure(insert({ source: a.id, user: actor.id }), /mentions_source_target_uq/);

		const comment = (
			await db
				.insert(comments)
				.values({ labourId: a.id, authorId: actor.id, body: 'x' })
				.returning()
		)[0];
		await insert({ source: a.id, comment: comment.id, labour: b.id });
		await expectFailure(
			insert({ source: a.id, comment: comment.id, labour: b.id }),
			/mentions_source_target_uq/
		);
	});

	it('takes exactly one target that is not the source', async () => {
		const a = await labour();
		await expectFailure(insert({ source: a.id }), /mentions_one_target/);
		await expectFailure(insert({ source: a.id, labour: a.id }), /mentions_not_self/);
		await expectFailure(
			insert({ source: a.id, labour: (await labour()).id, user: actor.id }),
			/mentions_one_target/
		);
	});
});

describe('search', () => {
	it('turns any text into a safe expression', async () => {
		expect(tsQuery("boss-hp don't!")).toBe("'boss' | 'hp' | 'don' | 't'");
		expect(tsQuery('  -- ""  ')).toBeNull();
		expect((await keywordScores(db, 'AND OR NOT "unbalanced (*')).size).toBe(0);
		expect((await keywordScores(db, '***')).size).toBe(0);
	});

	it('scores the best match 1 and stems', async () => {
		const strong = await labour({ title: 'dragons dragons' });
		const weak = await labour({ description: 'a dragon sleeps' });
		await labour({ title: 'unrelated' });

		const scores = await keywordScores(db, 'dragon');

		expect(scores.get(strong.id)).toBe(1);
		expect(scores.get(weak.id)).toBeGreaterThan(0);
		expect(scores.get(weak.id)).toBeLessThan(1);
		expect(scores.size).toBe(2);
	});
});

describe('rebuildDerived', () => {
	it('builds every structure once and records them', async () => {
		const now = new Date('2026-05-01T00:00:00Z');

		expect(await rebuildDerived(db, now)).toEqual(['labour_text', 'mentions', 'embedding_inputs']);
		expect(await rebuildDerived(db, now)).toEqual([]);
		expect(await db.select().from(derivedBuilds)).toEqual([
			{ name: 'labour_text', version: DERIVED_VERSIONS.labour_text, builtAt: now },
			{ name: 'mentions', version: DERIVED_VERSIONS.mentions, builtAt: now },
			{ name: 'embedding_inputs', version: DERIVED_VERSIONS.embedding_inputs, builtAt: now }
		]);
	});

	it('rebuilds a structure whose stored version is behind', async () => {
		await rebuildDerived(db);
		await db.update(derivedBuilds).set({ version: 0 }).where(eq(derivedBuilds.name, 'mentions'));

		expect(await rebuildDerived(db)).toEqual(['mentions']);
	});

	it('restores wiped rows, keeping surviving Mentions and seeding new ones from the text', async () => {
		const target = await labour();
		const owner = await seedUser(db, 'ada');
		const source = await labour({ ownerId: owner, description: `${target.key} @ada` });
		const comment = await addComment(db, actor, source.id, `again ${target.key}`);
		const kept = await db.select().from(mentions);
		await db.delete(mentions).where(eq(mentions.userId, owner));
		await db.$client.query('DELETE FROM labour_text');

		await db.delete(derivedBuilds);
		await rebuildDerived(db);

		expect(await textOf(source.id)).toMatchObject({
			description: `${target.key} @ada`,
			comments: `again ${target.key}`
		});
		const after = await db.select().from(mentions);
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

	it('rebuilds 2,000 Labours in good time', async () => {
		const owner = await seedUser(db, 'bulk');
		const first = await labour({ ownerId: owner });
		for (let i = 0; i < 1999; i += 1) {
			await createLabour(db, actor, {
				realmId,
				title: `Labour ${i}`,
				ownerId: owner,
				description: `see ${first.key} and @bulk about dragons`
			});
		}
		await db.$client.query('DELETE FROM labour_text');
		await db.delete(mentions);

		const started = performance.now();
		await rebuildDerived(db);
		const took = performance.now() - started;

		expect(await textRows()).toBe(2000);
		expect(await db.select().from(mentions)).toHaveLength(3998);
		expect(took).toBeLessThan(20_000);
	}, 60_000);
});
