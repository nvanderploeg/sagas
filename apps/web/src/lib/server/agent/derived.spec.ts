import { asc, eq } from 'drizzle-orm';
import { generateNKeysBetween } from 'fractional-indexing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import {
	comments,
	derivedBuilds,
	events,
	labourInputs,
	labours,
	mentions
} from '#lib/server/db/schema.ts';
import { addComment, editComment } from '#lib/server/domain/comments.ts';
import { createLabour, moveLabour } from '#lib/server/domain/labours.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import { appraise } from './appraisals.ts';
import { defineAttribute } from './attributes.ts';
import { DERIVED_VERSIONS, rebuildDerived } from './derived.ts';
import { inputHash } from './vectors/input.ts';

let db: Db;
let actor: Actor;
let ada: number;
let bob: number;
let amId: number;
let target: { id: number };

const T1 = new Date('2030-01-01T00:00:00.000Z');
const T2 = new Date('2030-02-01T00:00:00.000Z');
const T3 = new Date('2030-03-01T00:00:00.000Z');
const BUILT = new Date('2031-01-01T00:00:00.000Z');
const REBUILT = new Date('2032-01-01T00:00:00.000Z');

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(T1);
	db = await testDb();
	actor = await seedActor(db);
	ada = await seedUser(db, 'ada');
	bob = await seedUser(db, 'bob');
	amId = (await seedRealm(db, 'AM')).id;
	target = await seedLabour(db, { realmId: amId, title: 'Target', ownerId: ada });
});

afterEach(() => {
	vi.useRealTimers();
});

type TextRow = {
	id: number;
	title: string;
	brief: string;
	description: string;
	comments: string;
	notes: string;
};

const textRows = async () =>
	(
		await db.$client.query<TextRow>(
			'SELECT labour_id AS id, title, brief, description, comments, notes FROM labour_text ORDER BY labour_id'
		)
	).rows;

const wipeText = () => db.$client.query('DELETE FROM labour_text');

const mentionRows = async () => await db.select().from(mentions).orderBy(asc(mentions.id));

const shape = (rows: (typeof mentions.$inferSelect)[]) =>
	rows
		.map(
			(row) =>
				`${row.sourceLabourId}|${row.commentId}|${row.labourId}|${row.userId}|${row.authorId}|${row.firstSeenAt.getTime()}`
		)
		.sort();

const row = (
	sourceLabourId: number,
	commentId: number | null,
	labourId: number | null,
	userId: number | null,
	authorId: number,
	firstSeenAt: Date
) => `${sourceLabourId}|${commentId}|${labourId}|${userId}|${authorId}|${firstSeenAt.getTime()}`;

const buildRecords = async () =>
	await db.select().from(derivedBuilds).orderBy(asc(derivedBuilds.name));

const eventCount = async () => (await db.select().from(events)).length;

async function setBody(labourId: number, description: string) {
	await db.update(labours).set({ description }).where(eq(labours.id, labourId));
}

// Text in every column of labour_text, Mentions of both kinds and of Comments, written through
// the board and agent writes at three different times.
async function buildWorld() {
	const bl = await seedRealm(db, 'BL');
	const other = await seedLabour(db, { realmId: bl.id, title: 'Other realm', ownerId: bob });
	await defineAttribute(db, actor, amId, {
		key: 'repro',
		kind: 'text',
		label: 'Repro',
		rubric: 'Steps'
	});
	await defineAttribute(db, actor, amId, {
		key: 'context',
		kind: 'text',
		label: 'Context',
		rubric: 'Where seen',
		index: 0
	});
	await defineAttribute(db, actor, amId, {
		key: 'severity',
		kind: 'scale',
		label: 'Severity',
		rubric: 'How bad',
		spec: { min: 1, max: 5 }
	});

	vi.setSystemTime(T1);
	const main = await createLabour(db, actor, {
		realmId: amId,
		title: 'Boss HP feels wrong',
		description: 'see AM-1 and @ada',
		ownerId: bob
	});
	vi.setSystemTime(T2);
	const first = await addComment(db, { id: ada }, main.id, 'cc @bob, relates to AM-1');
	const second = await addComment(db, actor, main.id, 'plain second comment');
	vi.setSystemTime(T3);
	await editComment(db, { id: ada }, first.id, 'cc @bob, relates to AM-1 and BL-1');
	await appraise(db, actor, [
		{
			labourId: main.id,
			brief: 'Players say the boss is a sponge',
			values: { repro: 'Fight the boss', context: 'Stream clip', severity: 4 }
		}
	]);
	const bare = await seedLabour(db, { realmId: amId, title: 'Bare', ownerId: ada });
	return { bl, other, main, first, second, bare };
}

describe('DERIVED_VERSIONS', () => {
	it('starts every structure at version 1', () => {
		expect(DERIVED_VERSIONS).toEqual({ labour_text: 1, mentions: 1, embedding_inputs: 1 });
	});
});

describe('rebuildDerived: what it rebuilds', () => {
	it('builds every structure on the first run and says so', async () => {
		const names = await rebuildDerived(db, BUILT);

		expect([...names].sort()).toEqual(['embedding_inputs', 'labour_text', 'mentions']);
		expect(await buildRecords()).toMatchObject([
			{ name: 'embedding_inputs', version: DERIVED_VERSIONS.embedding_inputs, builtAt: BUILT },
			{ name: 'labour_text', version: DERIVED_VERSIONS.labour_text, builtAt: BUILT },
			{ name: 'mentions', version: DERIVED_VERSIONS.mentions, builtAt: BUILT }
		]);
	});

	it('does nothing on the second run', async () => {
		await buildWorld();
		await rebuildDerived(db, BUILT);
		const text = await textRows();
		const rows = await mentionRows();

		const names = await rebuildDerived(db, REBUILT);

		expect(names).toEqual([]);
		expect((await buildRecords()).map((record) => record.builtAt)).toEqual([BUILT, BUILT, BUILT]);
		expect(await textRows()).toEqual(text);
		expect(await mentionRows()).toEqual(rows);
	});

	it('rebuilds only the structure whose recorded version is below the code version', async () => {
		await buildWorld();
		await rebuildDerived(db, BUILT);
		await wipeText();
		await db.delete(mentions);
		await db.update(derivedBuilds).set({ version: 0 }).where(eq(derivedBuilds.name, 'mentions'));

		const names = await rebuildDerived(db, REBUILT);

		expect(names).toEqual(['mentions']);
		expect((await mentionRows()).length).toBeGreaterThan(0);
		expect(await textRows()).toEqual([]);
		expect(await buildRecords()).toMatchObject([
			{ name: 'embedding_inputs', builtAt: BUILT },
			{ name: 'labour_text', version: DERIVED_VERSIONS.labour_text, builtAt: BUILT },
			{ name: 'mentions', version: DERIVED_VERSIONS.mentions, builtAt: REBUILT }
		]);
	});

	it('rebuilds labour_text alone when only its version is stale', async () => {
		await buildWorld();
		await rebuildDerived(db, BUILT);
		await wipeText();
		await db.delete(mentions);
		await db.update(derivedBuilds).set({ version: 0 }).where(eq(derivedBuilds.name, 'labour_text'));

		const names = await rebuildDerived(db, REBUILT);

		expect(names).toEqual(['labour_text']);
		expect((await textRows()).length).toBeGreaterThan(0);
		expect(await mentionRows()).toEqual([]);
		expect(await buildRecords()).toMatchObject([
			{ name: 'embedding_inputs', builtAt: BUILT },
			{ name: 'labour_text', version: DERIVED_VERSIONS.labour_text, builtAt: REBUILT },
			{ name: 'mentions', version: DERIVED_VERSIONS.mentions, builtAt: BUILT }
		]);
	});

	it('rebuilds a structure whose record is missing', async () => {
		await buildWorld();
		await rebuildDerived(db, BUILT);
		await db.delete(derivedBuilds).where(eq(derivedBuilds.name, 'mentions'));

		expect(await rebuildDerived(db, REBUILT)).toEqual(['mentions']);
	});

	it('leaves a structure recorded at a higher version alone', async () => {
		await rebuildDerived(db, BUILT);
		await db.update(derivedBuilds).set({ version: 99 });
		await wipeText();

		expect(await rebuildDerived(db, REBUILT)).toEqual([]);
		expect(await textRows()).toEqual([]);
	});

	it('defaults the build time to now', async () => {
		vi.setSystemTime(T3);

		await rebuildDerived(db);

		expect((await buildRecords()).map((record) => record.builtAt)).toEqual([T3, T3, T3]);
	});

	it('records no Event and moves no updatedAt', async () => {
		await buildWorld();
		const eventsBefore = await eventCount();
		const stamps = await db
			.select({ id: labours.id, updatedAt: labours.updatedAt })
			.from(labours)
			.orderBy(asc(labours.id));
		await db.delete(mentions);
		await wipeText();

		await rebuildDerived(db, BUILT);

		expect(await eventCount()).toBe(eventsBefore);
		expect(
			await db
				.select({ id: labours.id, updatedAt: labours.updatedAt })
				.from(labours)
				.orderBy(asc(labours.id))
		).toEqual(stamps);
	});
});

describe('rebuildDerived: labour_text', () => {
	it('rebuilds exactly what the writes kept current', async () => {
		await buildWorld();
		const live = await textRows();
		expect(live.length).toBeGreaterThanOrEqual(4);
		const main = live.find((r) => r.title === 'Boss HP feels wrong')!;
		expect(main).toMatchObject({
			description: 'see AM-1 and @ada',
			brief: 'Players say the boss is a sponge',
			comments: 'cc @bob, relates to AM-1 and BL-1\n\nplain second comment',
			notes: 'Stream clip\n\nFight the boss'
		});
		await wipeText();

		expect(await rebuildDerived(db, BUILT)).toContain('labour_text');

		expect(await textRows()).toEqual(live);
	});

	it('replaces rows that drifted', async () => {
		await buildWorld();
		const live = await textRows();
		await wipeText();
		const insert = (id: number, ...text: string[]) =>
			db.$client.query(
				'INSERT INTO labour_text (labour_id, title, brief, description, comments, notes) VALUES ($1, $2, $3, $4, $5, $6)',
				[id, ...text]
			);
		await insert(target.id, 'stale title', 'stale', 'stale', 'stale', 'stale');

		await rebuildDerived(db, BUILT);

		expect(await textRows()).toEqual(live);
	});

	it('picks up text written around the board', async () => {
		await rebuildDerived(db, BUILT);
		await db
			.update(labours)
			.set({ title: 'Changed behind its back' })
			.where(eq(labours.id, target.id));
		await db.update(derivedBuilds).set({ version: 0 }).where(eq(derivedBuilds.name, 'labour_text'));

		await rebuildDerived(db, REBUILT);

		expect((await textRows()).find((r) => r.id === target.id)?.title).toBe(
			'Changed behind its back'
		);
	});
});

describe('rebuildDerived: embedding_inputs', () => {
	const inputRows = async () =>
		await db.select().from(labourInputs).orderBy(asc(labourInputs.labourId));
	const redoInputs = async () => {
		await db.delete(derivedBuilds).where(eq(derivedBuilds.name, 'embedding_inputs'));
		return rebuildDerived(db, REBUILT);
	};

	it('rebuilds exactly what the writes kept current', async () => {
		await buildWorld();
		await rebuildDerived(db, BUILT);
		const live = await inputRows();
		expect(live).toHaveLength((await db.select().from(labours)).length);
		await db.delete(labourInputs);

		expect(await redoInputs()).toEqual(['embedding_inputs']);

		expect(await inputRows()).toEqual(live);
	});

	it('hashes the title, Brief and description as they stand', async () => {
		const { main } = await buildWorld();
		await rebuildDerived(db, BUILT);
		await setBody(main.id, 'Edited behind its back');

		await redoInputs();

		expect((await inputRows()).find((r) => r.labourId === main.id)?.inputHash).toBe(
			inputHash({
				title: 'Boss HP feels wrong',
				brief: 'Players say the boss is a sponge',
				description: 'Edited behind its back'
			})
		);
	});

	it('fills every Labour, past the first chunk', async () => {
		const base = (await db.select().from(labours).where(eq(labours.id, target.id)).limit(1))[0]!;
		const ranks = generateNKeysBetween(base.rank, null, 1_200);
		await db.insert(labours).values(
			ranks.map((rank, i) => ({
				realmId: amId,
				number: 1_000 + i,
				title: `Bulk ${i}`,
				ownerId: ada,
				stateId: base.stateId,
				rank
			}))
		);
		await db.delete(labourInputs);

		await rebuildDerived(db, BUILT);

		expect(await inputRows()).toHaveLength(1_201);
	});
});

describe('rebuildDerived: mentions', () => {
	const redoMentions = async () => {
		await db.delete(derivedBuilds).where(eq(derivedBuilds.name, 'mentions'));
		return rebuildDerived(db, REBUILT);
	};

	it('keeps every existing row whose text still names the target, id and all', async () => {
		await buildWorld();
		const before = await mentionRows();
		expect(before.length).toBeGreaterThanOrEqual(5);
		vi.setSystemTime(new Date('2040-01-01T00:00:00.000Z'));

		await redoMentions();

		expect(await mentionRows()).toEqual(before);
	});

	it('keeps the firstSeenAt and authorId a row was given, not what a rebuild would seed', async () => {
		const { main } = await buildWorld();
		const descriptionRow = (await mentionRows()).find(
			(r) => r.sourceLabourId === main.id && r.commentId === null && r.labourId === target.id
		)!;
		await db
			.update(mentions)
			.set({ authorId: bob, firstSeenAt: T3 })
			.where(eq(mentions.id, descriptionRow.id));

		await redoMentions();

		expect((await mentionRows()).find((r) => r.id === descriptionRow.id)).toMatchObject({
			authorId: bob,
			firstSeenAt: T3
		});
	});

	it('seeds missing rows from the Comment, or from the Labour and its Owner', async () => {
		const { main, first, other } = await buildWorld();
		await db.delete(mentions);

		await redoMentions();

		expect(shape(await mentionRows())).toEqual(
			[
				row(main.id, null, target.id, null, bob, T1),
				row(main.id, null, null, ada, bob, T1),
				row(main.id, first.id, target.id, null, ada, T2),
				row(main.id, first.id, null, bob, ada, T2),
				row(main.id, first.id, other.id, null, ada, T2)
			].sort()
		);
	});

	it('seeds from createdAt, not the time of a later edit', async () => {
		const { main, first, other } = await buildWorld();
		const added = (await mentionRows()).find(
			(r) => r.commentId === first.id && r.labourId === other.id
		)!;
		expect(added.firstSeenAt).toEqual(T3);
		await db.delete(mentions).where(eq(mentions.id, added.id));

		await redoMentions();

		const reseeded = (await mentionRows()).find(
			(r) => r.commentId === first.id && r.labourId === other.id
		)!;
		expect(reseeded.firstSeenAt).toEqual(T2);
		expect(reseeded.authorId).toBe(ada);
		expect(reseeded.sourceLabourId).toBe(main.id);
	});

	it('deletes a row whose text no longer names the target', async () => {
		const { main, first } = await buildWorld();
		const before = await mentionRows();
		await setBody(main.id, 'only @ada now');
		await db.update(comments).set({ body: 'nothing to see' }).where(eq(comments.id, first.id));

		await redoMentions();

		expect(shape(await mentionRows())).toEqual(
			shape(before.filter((r) => r.commentId === null && r.userId === ada))
		);
	});

	it('keeps, deletes and adds in one pass', async () => {
		const source = await seedLabour(db, {
			realmId: amId,
			title: 'Source',
			description: 'AM-1 and @bob',
			ownerId: ada
		});
		const own = (await mentionRows()).filter((r) => r.sourceLabourId === source.id);
		expect(own).toHaveLength(2);
		const targetRow = own.find((r) => r.labourId === target.id)!;
		const userRow = own.find((r) => r.userId === bob)!;
		await db.delete(mentions).where(eq(mentions.id, userRow.id));
		await db.update(mentions).set({ firstSeenAt: T3 }).where(eq(mentions.id, targetRow.id));
		await db.insert(mentions).values({
			sourceLabourId: source.id,
			commentId: null,
			labourId: null,
			userId: ada,
			authorId: bob,
			firstSeenAt: T3
		});

		await redoMentions();

		expect(shape((await mentionRows()).filter((r) => r.sourceLabourId === source.id))).toEqual(
			[
				row(source.id, null, target.id, null, actor.id, T3),
				row(source.id, null, null, bob, ada, T1)
			].sort()
		);
		expect((await mentionRows()).some((r) => r.id === targetRow.id)).toBe(true);
	});

	it('does not keep a description row for a target only a Comment names', async () => {
		const source = await seedLabour(db, { realmId: amId, title: 'Source', ownerId: ada });
		await addComment(db, { id: bob }, source.id, 'AM-1');
		const [commentRow] = (await mentionRows()).filter((r) => r.sourceLabourId === source.id);
		await db.insert(mentions).values({
			sourceLabourId: source.id,
			commentId: null,
			labourId: target.id,
			userId: null,
			authorId: ada,
			firstSeenAt: T1
		});

		await redoMentions();

		expect((await mentionRows()).filter((r) => r.sourceLabourId === source.id)).toEqual([
			commentRow
		]);
	});

	it('adds a Mention of a Labour or User created after the text', async () => {
		const labour = await seedLabour(db, {
			realmId: amId,
			title: 'Early',
			description: 'depends on AM-3 and @carol',
			ownerId: bob
		});
		const later = await seedLabour(db, { realmId: amId, title: 'Later', ownerId: ada });
		const carol = await seedUser(db, 'carol');
		expect((await mentionRows()).filter((r) => r.sourceLabourId === labour.id)).toEqual([]);

		await redoMentions();

		expect(shape(await mentionRows())).toEqual(
			[
				row(labour.id, null, later.id, null, bob, T1),
				row(labour.id, null, null, carol, bob, T1)
			].sort()
		);
	});

	it('applies the extraction rules: aliases, own key, unknown targets and duplicates', async () => {
		const bl = await seedRealm(db, 'BL');
		await seedUser(db, 'carol');
		await moveLabour(db, actor, target.id, { realmId: bl.id });
		const source = await seedLabour(db, { realmId: amId, title: 'Source', ownerId: bob });
		const moved = await moveLabour(db, actor, source.id, { realmId: bl.id });
		await setBody(
			source.id,
			`AM-1 am-1 BL-1 ${moved.key} AM-2 AM-999 XAM-1x @ada @ADA @nobody a@carol.com @bob_`
		);
		const comment = await addComment(db, actor, source.id, 'plain');
		await db.update(comments).set({ body: 'AM-1 @ada' }).where(eq(comments.id, comment.id));
		await db.delete(mentions);

		await redoMentions();

		expect(shape(await mentionRows())).toEqual(
			[
				row(source.id, null, target.id, null, bob, T1),
				row(source.id, null, null, ada, bob, T1),
				row(source.id, null, null, bob, bob, T1),
				row(source.id, comment.id, target.id, null, actor.id, T1),
				row(source.id, comment.id, null, ada, actor.id, T1)
			].sort()
		);
	});

	it('rebuilds from nothing when every structure is empty', async () => {
		await db.delete(mentions);
		await wipeText();

		expect((await rebuildDerived(db, BUILT)).sort()).toEqual([
			'embedding_inputs',
			'labour_text',
			'mentions'
		]);
		expect(await mentionRows()).toEqual([]);
		expect((await textRows()).map((r) => r.id)).toEqual([target.id]);
	});
});
